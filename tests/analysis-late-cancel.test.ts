// @vitest-environment node
import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { AppEvent } from '../src/shared/api';

const state = vi.hoisted(() => ({ spawn: vi.fn(), probe: vi.fn(), prepare: vi.fn(), log: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: state.spawn, default: { spawn: state.spawn } }));
vi.mock('../src/main/macos/analysis', () => ({ startMacAnalysis: vi.fn() }));
vi.mock('../src/main/logger', () => ({ logLine: state.log }));
vi.mock('../src/main/probe', () => ({ probeVideo: state.probe }));
vi.mock('../src/main/components', () => ({
  resolveUsableAnalysisComponents: vi.fn().mockResolvedValue({ python: 'python', worker: 'worker', runtimeVariant: 'external', blurballWeights: 'model.onnx' }),
  resolveUsableMediaComponents: vi.fn().mockResolvedValue({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', mediaEncoder: 'libx264' }),
}));
vi.mock('../src/main/processing-media', () => ({
  CfrNormalizationError: class extends Error {}, prepareProcessingMedia: state.prepare,
  retainOriginalVfrMedia: vi.fn(), removeProcessingCache: vi.fn(), targetFrameRateRatio: () => '30/1',
}));
vi.mock('../src/main/history', () => ({ getHistoryStore: () => ({ hasProcessingMediaReference: vi.fn() }) }));

import { startAnalysis } from '../src/main/analysis';
import { activeTaskIds, cancelTask } from '../src/main/processes';

it('reports the actual worker exit when cancellation arrives after failure classification', async () => {
  const actualPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  const video = { path: 'C:/video/source.mp4', duration_seconds: 30, width: 1280, height: 720,
    fps: 30, frame_count: 900, variable_frame_rate: false, video_codec: 'h264', audio_codec: 'aac', container: 'mp4' };
  const calibration = { video_width: 1280, video_height: 720,
    points: { top_left: [400, 200] as [number, number], top_right: [880, 200] as [number, number],
      bottom_right: [1050, 620] as [number, number], bottom_left: [230, 620] as [number, number] } };
  state.probe.mockResolvedValue(video);
  state.prepare.mockResolvedValue({ metadata: video, mode: 'original_cfr', targetFpsRatio: null,
    encoder: 'libx264', warningCode: null, cacheCreated: false, cachePath: null });
  let mark!: () => void; let release!: () => void;
  const reached = new Promise<void>((resolve) => { mark = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  state.log.mockImplementation(async (_task: string, _level: string, message: string) => {
    if (message.startsWith('Analysis failed:')) { mark(); await gate; }
  });
  state.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
      stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
      killed: false, kill: vi.fn(), stdin: { end: () => { queueMicrotask(() => child.emit('close', 1, null)); } },
    });
    return child;
  });
  const events: AppEvent[] = [];
  const window = { isDestroyed: () => false, webContents: { send: (_: string, event: AppEvent) => events.push(event) } } as unknown as BrowserWindow;
  try {
    const taskId = await startAnalysis(window, { videoPath: video.path, calibrationChoice: { method: 'manual', calibration },
      device: 'cpu', historyVisibility: 'visible', normalizeVariableFrameRate: false });
    await Promise.race([reached, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('failure log not reached')), 5_000))]);
    await cancelTask(taskId, 'user'); release();
    await vi.waitFor(() => expect(events.some((event) => event.type === 'error')).toBe(true));
    expect(events.filter((event) => event.type === 'error')).toEqual([
      expect.objectContaining({ type: 'error', taskId, code: 'WORKER_EXITED', message: expect.stringContaining('code 1') }),
    ]);
  } finally {
    release();
    for (const taskId of activeTaskIds()) await cancelTask(taskId, 'user');
    Object.defineProperty(process, 'platform', { value: actualPlatform });
  }
});
