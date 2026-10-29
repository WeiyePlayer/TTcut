// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { AppEvent } from '../src/shared/api';
import type { AnalysisResultV1, Calibration } from '../src/shared/contracts';
import type { HistoryStore as Store } from '../src/main/history';

const state = vi.hoisted(() => ({ store: null as Store | null, userData: '' }));
vi.mock('../src/main/history', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/main/history')>(), getHistoryStore: () => state.store!,
}));
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => os.tmpdir(), getPath: () => state.userData }, dialog: {} }));
vi.mock('../src/main/components', () => ({ resolveUsableMediaComponents: () => { throw new Error('unexpected'); } }));
import { HistoryStore } from '../src/main/history';
import { startExport } from '../src/main/export';

let directory = '';
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); state.store = null; });
it('keeps a completed XML when the actual log directory is unavailable', async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'ttcut-export-log-'));
  const source = path.join(directory, 'original.mov');
  await writeFile(source, 'original-video');
  state.userData = path.join(directory, 'not-a-directory');
  await writeFile(state.userData, 'not a directory');
  state.store = new HistoryStore(path.join(directory, 'history'), async (_source, cover) => { await writeFile(cover, 'cover'); });
  const calibration: Calibration = { video_width: 320, video_height: 180,
    points: { top_left: [60, 40], top_right: [250, 40], bottom_right: [275, 145], bottom_left: [40, 145] } };
  const video: AnalysisResultV1['video'] = { path: source, container: 'mov', width: 320, height: 180,
    duration_seconds: 1000, fps: 30, variable_frame_rate: false, video_codec: 'hevc', audio_codec: null };
  const analysis: AnalysisResultV1 = { schema_version: 1, video,
    rallies: [{ id: 'rally_001', index: 1, bounce_count: 5, start_time_seconds: 600, end_time_seconds: 601 }] };
  const record = await state.store.upsert(analysis, calibration);
  const events: AppEvent[] = [];
  const window = { isDestroyed: () => false, webContents: { send: (_channel: string, event: AppEvent) => events.push(event) } } as unknown as BrowserWindow;
  await startExport(window, { analysis_id: record.id, destination: 'source',
    selection: { mode: 'custom', segments: [{ rally_id: 'rally_001', start_time_seconds: 600, end_time_seconds: 601 }] },
    outputs: { combined_video: false, rally_videos: false, premiere_xml: true } });
  await vi.waitFor(() => expect(events.some((event) => event.type === 'error' || event.type === 'export-result')).toBe(true));
  const terminal = events.filter((event) => event.type === 'error' || event.type === 'export-result');
  expect(terminal).toHaveLength(1);
  const result = terminal[0];
  if (result?.type !== 'export-result' || result.data.kind !== 'custom-artifacts') throw new Error(JSON.stringify(result));
  expect(result.data.xmlFailure).toBeNull();
  expect(await readFile(result.data.premiereXml!.outputPath, 'utf8')).toContain('original.mov');
});
