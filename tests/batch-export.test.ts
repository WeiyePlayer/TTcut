import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEvent } from '../src/shared/api';
import { batchExportRequestSchema, type AnalysisResultV1, type HistoryRecordV1 } from '../src/shared/contracts';

const state = vi.hoisted(() => ({
  records: new Map<string, HistoryRecordV1>(),
  events: [] as AppEvent[],
  run: vi.fn(),
  validate: vi.fn(),
  open: vi.fn(),
  markVisible: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('electron', () => ({ dialog: {} }));
vi.mock('../src/main/logger', () => ({ logLine: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/main/history', () => ({ getHistoryStore: () => ({ open: state.open, markVisible: state.markVisible }) }));
vi.mock('../src/main/media-protocol', () => ({ registerMediaPath: (value: string) => `media:${value}` }));
vi.mock('../src/main/components', () => ({ resolveUsableMediaComponents: vi.fn().mockResolvedValue({
  ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', mediaEncoder: 'libx264',
}) }));
vi.mock('../src/main/export', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/main/export')>(),
  assertExportPreconditions: vi.fn().mockResolvedValue(undefined),
  runFfmpeg: state.run,
  validateExportOutput: state.validate,
}));

import { startBatchExport } from '../src/main/batch-export';
import { cancelAllTasksAndWait, cancelTask, hasActiveTasks } from '../src/main/processes';

const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const selection = { mode: 'all', pre_roll_seconds: 1.5, post_roll_seconds: 0.5 } as const;
const request = { items: ids.map((analysis_id) => ({ analysis_id, selection })) };
const windowStub = { isDestroyed: () => false, webContents: { send: (_channel: string, event: AppEvent) => {
  if (event.type === 'batch-export-result' || event.type === 'error') expect(hasActiveTasks()).toBe(false);
  state.events.push(event);
} } } as unknown as BrowserWindow;

describe('batch export task', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'ttcut-batch-test-'));
    state.events.length = 0;
    state.records.clear();
    state.markVisible.mockClear();
    state.open.mockReset().mockImplementation(async (id: string) => state.records.get(id));
    state.run.mockReset().mockImplementation(async (_window, _id, _exe, args: string[]) => {
      if (args.at(-1) !== '-') await writeFile(args.at(-1)!, 'validated-video');
    });
    state.validate.mockReset().mockImplementation(async (_file, _timing, profile) => ({ metadata: profile }));
    for (const [index, id] of ids.entries()) {
      const source = path.join(root, `video-${index}.mp4`);
      const analysis: AnalysisResultV1 = {
        schema_version: 1,
        video: { path: source, duration_seconds: 8, width: 320, height: 180, fps: 30,
          variable_frame_rate: false, video_codec: 'h264', audio_codec: null, container: 'mp4' },
        rallies: [{ id: 'rally_001', index: 1, bounce_count: 5, start_time_seconds: 2, end_time_seconds: 3 }],
      };
      state.records.set(id, { id, analysis, source: { path: source, name: path.basename(source), size: 1, modified_time_ms: 1 } } as HistoryRecordV1);
    }
  });
  afterEach(async () => {
    await cancelAllTasksAndWait();
    await rm(root, { recursive: true, force: true });
  });

  it('rejects empty, duplicate, custom and path-bearing requests before reserving a task', async () => {
    for (const value of [
      { items: [] }, { items: [request.items[0], request.items[0]] },
      { items: [{ analysis_id: ids[0], selection: { mode: 'custom', segments: [] } }] },
      { ...request, outputPath: 'C:\\arbitrary.mp4' },
    ]) {
      expect(batchExportRequestSchema.safeParse(value).success).toBe(false);
      await expect(startBatchExport(windowStub, value)).rejects.toThrow();
      expect(hasActiveTasks()).toBe(false);
    }
  });

  it('reserves the task before reading history and accepts cancellation during that read', async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    state.open.mockImplementation(async (id: string) => { await wait; return state.records.get(id); });
    const taskId = await startBatchExport(windowStub, request);
    expect(hasActiveTasks()).toBe(true);
    await expect(startBatchExport(windowStub, request)).rejects.toThrow('TASK_BUSY');
    await cancelTask(taskId);
    release();
    await vi.waitFor(() => expect(state.events).toContainEqual(expect.objectContaining({ type: 'error', code: 'EXPORT_CANCELLED' })));
    expect(state.run).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });

  it('skips empty sources while keeping the first participating source as output location', async () => {
    state.records.get(ids[0]!)!.analysis.rallies = [];
    await startBatchExport(windowStub, request);
    await vi.waitFor(() => expect(state.events.some((event) => event.type === 'batch-export-result')).toBe(true));
    const result = state.events.find((event) => event.type === 'batch-export-result')!;
    if (result.type !== 'batch-export-result') throw new Error('Missing result');
    expect(result.data.outputPath).toBe(path.join(root, 'video-0_TTcut_合并集锦.mp4'));
    expect(result.data.skippedAnalysisIds).toEqual([ids[0]]);
    expect(await readdir(root)).toEqual(['video-0_TTcut_合并集锦.mp4']);
    const segmentCalls = state.run.mock.calls.filter((call) => call[6]?.segmentIndex);
    expect(segmentCalls).toHaveLength(1);
    expect(segmentCalls[0]![3]).toContain(state.records.get(ids[1]!)!.analysis.video.path);
  });

  it('returns an empty-selection error without publishing a file', async () => {
    state.records.forEach((record) => { record.analysis.rallies = []; });
    await startBatchExport(windowStub, request);
    await vi.waitFor(() => expect(state.events).toContainEqual(expect.objectContaining({ type: 'error', code: 'BATCH_EXPORT_EMPTY' })));
    expect(state.run).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });

  it('retains a cached deferred analysis without assigning the merged output to its history', async () => {
    state.records.get(ids[0]!)!.visible_in_history = false;
    await startBatchExport(windowStub, request);
    await vi.waitFor(() => expect(state.events.some((event) => event.type === 'batch-export-result')).toBe(true));
    expect(state.markVisible).toHaveBeenCalledExactlyOnceWith(ids[0], 'analysis');
  });

  it('skips an empty highlight selection but does not suppress an incompatible criterion', async () => {
    const highlight = { mode: 'highlight', criterion: { kind: 'bounce_count', threshold: 7 }, pre_roll_seconds: 1.5, post_roll_seconds: 0.5 };
    await startBatchExport(windowStub, { items: [{ analysis_id: ids[0], selection: highlight }, request.items[1]] });
    await vi.waitFor(() => expect(state.events.some((event) => event.type === 'batch-export-result')).toBe(true));
    const result = state.events.find((event) => event.type === 'batch-export-result');
    expect(result).toMatchObject({ data: { skippedAnalysisIds: [ids[0]] } });
    state.events.length = 0;
    await startBatchExport(windowStub, { items: [{ analysis_id: ids[0], selection: {
      ...highlight, criterion: { kind: 'duration_tier', tier: 'rally' },
    } }] });
    await vi.waitFor(() => expect(state.events).toContainEqual(expect.objectContaining({ type: 'error', code: 'INVALID_HIGHLIGHT_CRITERION' })));
  });

  it('does not publish a partial batch after a segment fails', async () => {
    state.run.mockImplementationOnce(async (_window, _id, _exe, args: string[]) => { await writeFile(args.at(-1)!, 'segment'); })
      .mockRejectedValueOnce(new Error('segment failed'));
    await startBatchExport(windowStub, request);
    await vi.waitFor(() => expect(state.events.some((event) => event.type === 'error')).toBe(true));
    expect(state.events.some((event) => event.type === 'batch-export-result')).toBe(false);
    expect(await readdir(root)).toEqual([]);
  });

  it('fully decodes before success and increments output collisions without replacing files', async () => {
    const original = path.join(root, 'video-0_TTcut_合并集锦.mp4');
    await writeFile(original, 'keep-me');
    await startBatchExport(windowStub, request);
    await vi.waitFor(() => expect(state.events.some((event) => event.type === 'batch-export-result')).toBe(true));
    expect(state.run.mock.calls.at(-1)![3]).toEqual(expect.arrayContaining(['-xerror', '-f', 'null']));
    expect(await readFile(original, 'utf8')).toBe('keep-me');
    expect(await readdir(root)).toEqual(['video-0_TTcut_合并集锦.mp4', 'video-0_TTcut_合并集锦_2.mp4']);
  });
});
