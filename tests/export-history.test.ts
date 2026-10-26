// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { AppEvent } from '../src/shared/api';
import type { AnalysisResultV1, Calibration } from '../src/shared/contracts';
import type { HistoryStore as Store } from '../src/main/history';
import nativeVideo from './fixtures/native-silent-hdr.json';
import { nativeVideoSchema } from '../src/shared/native-contracts';

const state = vi.hoisted(() => ({ store: null as Store | null }));
vi.mock('../src/main/history', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/main/history')>(),
  getHistoryStore: () => state.store!,
}));
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => os.tmpdir(), getPath: () => os.tmpdir() }, dialog: {} }));
vi.mock('../src/main/components', () => ({ resolveUsableMediaComponents: () => { throw new Error('XML_MUST_NOT_REQUIRE_ENCODER'); } }));
vi.mock('../src/main/logger', () => ({ logLine: vi.fn().mockResolvedValue(undefined) }));
import { HistoryStore } from '../src/main/history';
import { startExport } from '../src/main/export';

let directory: string;
const actualPlatform = process.platform;
afterEach(async () => {
  Object.defineProperty(process, 'platform', { value: actualPlatform });
  if (directory) await rm(directory, { recursive: true, force: true });
  state.store = null;
});

describe('XML export through stored history', () => {
  it.each(['win32', 'darwin'])('exports original-source XML when the %s analysis cache has disappeared', async (platform) => {
    Object.defineProperty(process, 'platform', { value: platform });
    directory = await mkdtemp(path.join(os.tmpdir(), 'ttcut-export-history-'));
    const source = path.join(directory, 'original.mov');
    await writeFile(source, 'original-video');
    state.store = new HistoryStore(path.join(directory, 'history'), async (_source, cover) => { await writeFile(cover, 'cover'); });
    const calibration: Calibration = { video_width: 320, video_height: 180,
      points: { top_left: [60, 40], top_right: [250, 40], bottom_right: [275, 145], bottom_left: [40, 145] } };
    const original: AnalysisResultV1['video'] = { path: source, container: 'mov', width: 320, height: 180,
      duration_seconds: 1000, fps: 30000 / 1001, nominal_fps: 30000 / 1001,
      nominal_fps_ratio: '30000/1001', variable_frame_rate: true, video_codec: 'hevc', audio_codec: null,
      media_fidelity: { hdr: 'dolbyVision', bit_depth: 10, chroma: '420', mastering_display: null, max_cll: null } };
    const analysis: AnalysisResultV1 = { schema_version: 1, source_video: original,
      video: { ...original, path: path.join(directory, 'missing-cfr.mp4'), container: 'mp4', variable_frame_rate: false,
        ...(platform === 'darwin' ? { native_video: nativeVideoSchema.parse(nativeVideo) } : {}) },
      processing: { mode: 'normalized_cfr', target_fps_ratio: '30000/1001', encoder: 'libx265', warning_code: null },
      rallies: [{ id: 'rally_001', index: 1, bounce_count: 5, start_time_seconds: 600, end_time_seconds: 601 }] };
    const record = await state.store.upsert(analysis, calibration);
    const recordPath = path.join(directory, 'history/records', `${record.id}.json`);
    const stored = await readFile(recordPath, 'utf8');
    const events: AppEvent[] = [];
    const window = { isDestroyed: () => false, webContents: { send: (_channel: string, event: AppEvent) => events.push(event) } } as unknown as BrowserWindow;
    await startExport(window, { analysis_id: record.id, destination: 'source',
      selection: { mode: 'custom', segments: [{ rally_id: 'rally_001', start_time_seconds: 600, end_time_seconds: 601 }] },
      outputs: { combined_video: false, rally_videos: false, premiere_xml: true } });
    await vi.waitFor(() => expect(events.some((event) => event.type === 'export-result' || event.type === 'error')).toBe(true));
    const result = events.find((event) => event.type === 'export-result');
    if (result?.type !== 'export-result' || result.data.kind !== 'custom-artifacts') throw new Error(JSON.stringify(events));
    expect(result.data).toMatchObject({ partialSuccess: false, rallyVideos: [], premiereXml: { quantizedForVfr: true }, xmlFailure: null });
    const xml = await readFile(result.data.premiereXml!.outputPath, 'utf8');
    expect(xml).toContain('original.mov');
    expect(xml).toContain('<in>17982</in>');
    expect(xml).not.toContain('missing-cfr');
    expect(await readFile(recordPath, 'utf8')).toBe(stored);
  });
});
