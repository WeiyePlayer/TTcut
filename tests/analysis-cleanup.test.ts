import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { AppEvent } from '../src/shared/api';
import type { Calibration, VideoMetadata } from '../src/shared/contracts';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), probe: vi.fn(), prepare: vi.fn(), referenced: vi.fn(), remove: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn, default: { spawn: mocks.spawn } }));
vi.mock('../src/main/macos/analysis', () => ({ startMacAnalysis: vi.fn() }));
vi.mock('../src/main/logger', () => ({ logLine: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/main/probe', () => ({ probeVideo: mocks.probe }));
vi.mock('../src/main/components', () => ({
  resolveUsableAnalysisComponents: vi.fn().mockResolvedValue({ python: 'python', worker: 'worker', blurballWeights: 'model.onnx' }),
  resolveUsableMediaComponents: vi.fn().mockResolvedValue({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', mediaEncoder: 'libx264' }),
}));
vi.mock('../src/main/processing-media', () => ({
  CfrNormalizationError: class extends Error {}, prepareProcessingMedia: mocks.prepare,
  retainOriginalVfrMedia: vi.fn(), removeProcessingCache: mocks.remove, targetFrameRateRatio: () => '30/1',
}));
vi.mock('../src/main/history', () => ({ getHistoryStore: () => ({ hasProcessingMediaReference: mocks.referenced }) }));

import { startAnalysis } from '../src/main/analysis';
import { beginTrackedTask, cancelTask, endTrackedTask, hasActiveTasks } from '../src/main/processes';

beforeEach(() => vi.clearAllMocks());

it.each([false, true])('releases the task after CFR cleanup and before terminal delivery (cancelled=%s)', async (cancelled) => {
  const metadata: VideoMetadata = { path: 'C:/video/source.mp4', duration_seconds: 30, width: 1280, height: 720,
    fps: 30, frame_count: 900, variable_frame_rate: true, video_codec: 'h264', audio_codec: 'aac', container: 'mp4' };
  const calibration: Calibration = { video_width: 1280, video_height: 720,
    points: { top_left: [400, 200], top_right: [880, 200], bottom_right: [1050, 620], bottom_left: [230, 620] } };
  mocks.probe.mockResolvedValue(metadata);
  mocks.prepare.mockResolvedValue({ metadata: { ...metadata, path: 'C:/cache/normalized.mp4', variable_frame_rate: false },
    mode: 'normalized_cfr', targetFpsRatio: '30/1', encoder: 'libx264', warningCode: null,
    cacheCreated: true, cachePath: 'C:/cache/normalized.mp4', cacheKey: 'test' });
  let finishReferenceLookup!: (value: boolean) => void;
  mocks.referenced.mockImplementation(() => new Promise<boolean>(resolve => { finishReferenceLookup = resolve; }));
  mocks.remove.mockResolvedValue(undefined);
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
      stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
      killed: false, kill: vi.fn(() => { child.killed = true; }),
      stdin: { end: (line: string) => { queueMicrotask(() => {
        const taskId = JSON.parse(line).task_id as string;
        if (cancelled) void cancelTask(taskId);
        child.stdout.emit('data', JSON.stringify({ task_id: taskId,
          type: 'error', code: 'INFERENCE_FAILED', message: 'simulated inference failure', recoverable: true }) + '\n');
        child.emit('close', 1, null);
      }); } },
    });
    return child;
  });
  const events: AppEvent[] = [];
  const window = { isDestroyed: () => false, webContents: { send: (_channel: string, event: AppEvent) => {
    if (event.type === 'error') {
      expect(hasActiveTasks()).toBe(false);
      expect(mocks.remove).toHaveBeenCalledOnce();
      beginTrackedTask('next-analysis');
      endTrackedTask('next-analysis');
    }
    events.push(event);
  } } } as unknown as BrowserWindow;
  await startAnalysis(window, { videoPath: metadata.path, calibrationChoice: { method: 'manual', calibration },
    device: 'cpu', historyVisibility: 'visible', normalizeVariableFrameRate: true });
  await vi.waitFor(() => expect(mocks.referenced).toHaveBeenCalledOnce());
  try {
    expect(events.some(event => event.type === 'error')).toBe(false);
    expect(hasActiveTasks()).toBe(true);
  } finally { finishReferenceLookup(false); }
  await vi.waitFor(() => expect(events.filter(event => event.type === 'error')).toEqual([
    expect.objectContaining({ type: 'error', code: cancelled ? 'ANALYSIS_CANCELLED' : 'INFERENCE_FAILED' }),
  ]));
  expect(hasActiveTasks()).toBe(false);
});
