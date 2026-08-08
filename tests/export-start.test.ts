import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEvent } from '../src/shared/api';
import type { AnalysisResultV1, ExportRequest } from '../src/shared/contracts';

const state = vi.hoisted(() => {
  let releaseKeyframes: ((value: number[]) => void) | null = null;
  return {
    source: '',
    events: [] as AppEvent[],
    keyframes: vi.fn((_path: string, _ffprobe: string, signal?: AbortSignal) => new Promise<number[]>((resolve, reject) => {
      const abort = () => reject(Object.assign(new Error('PROCESS_CANCELLED'), { name: 'AbortError' }));
      releaseKeyframes = (value) => {
        signal?.removeEventListener('abort', abort);
        resolve(value);
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    })),
    release: (value: number[]) => releaseKeyframes?.(value),
  };
});

vi.mock('electron', () => ({
  dialog: { showSaveDialog: vi.fn() },
}));

vi.mock('../src/main/components', () => ({
  resolveUsableMediaComponents: vi.fn().mockResolvedValue({
    ffmpeg: 'unused-ffmpeg.exe',
    ffprobe: 'unused-ffprobe.exe',
    mediaEncoder: 'libx264',
  }),
}));

vi.mock('../src/main/logger', () => ({
  logLine: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/main/media-protocol', () => ({
  registerMediaPath: vi.fn((value: string) => value),
}));

vi.mock('../src/main/probe', () => ({
  probeAudioPacketBoundaries: vi.fn().mockResolvedValue([]),
  probeKeyframes: state.keyframes,
  probeStreamSignature: vi.fn(),
  probeVideo: vi.fn(),
  sameStreamSignature: vi.fn(),
}));

vi.mock('../src/main/history', () => ({
  getHistoryStore: () => ({
    open: vi.fn(async () => ({
      id: '11111111-1111-4111-8111-111111111111',
      analysis: {
        schema_version: 1,
        video: {
          path: state.source,
          duration_seconds: 30,
          width: 1280,
          height: 720,
          fps: 30,
          variable_frame_rate: false,
          video_codec: 'h264',
          audio_codec: null,
          container: 'mp4',
          average_bitrate: 1_000_000,
          video_time_base: '1/16000',
        },
        rallies: [{
          id: 'rally_001',
          index: 1,
          bounce_count: 5,
          start_time_seconds: 10,
          end_time_seconds: 12,
        }],
      } satisfies AnalysisResultV1,
    })),
    markVisible: vi.fn(),
  }),
}));

import { startExport } from '../src/main/export';
import { cancelAllTasks, cancelTask, getTaskController } from '../src/main/processes';

const request: ExportRequest = {
  analysis_id: '11111111-1111-4111-8111-111111111111',
  selection: {
    mode: 'all',
    pre_roll_seconds: 2.5,
    post_roll_seconds: 2,
  },
  destination: 'source',
};

function windowMock() {
  return {
    isDestroyed: () => false,
    webContents: {
      send: (_channel: string, event: AppEvent) => state.events.push(event),
    },
  };
}

async function waitForTaskEnd(taskId: string): Promise<void> {
  for (let index = 0; index < 50 && getTaskController(taskId); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(getTaskController(taskId)).toBeUndefined();
}

describe('export task start and terminal lifecycle', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'ttcut-export-start-'));
    state.source = path.join(directory, 'source.mp4');
    state.events.length = 0;
    state.keyframes.mockClear();
    await writeFile(state.source, 'source');
  });

  afterEach(async () => {
    await cancelAllTasks('app-exit');
    state.release([]);
    await rm(directory, { recursive: true, force: true });
  });

  it('returns a registered taskId before keyframe probing finishes and emits one user-cancel terminal event', async () => {
    const taskId = await startExport(windowMock() as never, request);
    expect(taskId).toMatch(/^[0-9a-f-]{36}$/);
    expect(getTaskController(taskId)).toBeDefined();
    await vi.waitFor(() => expect(state.keyframes).toHaveBeenCalledTimes(1));

    await cancelTask(taskId, 'user');
    await waitForTaskEnd(taskId);
    const terminal = state.events.filter((event) => event.type === 'error' || event.type === 'export-result');
    expect(terminal).toEqual([
      expect.objectContaining({ type: 'error', taskId, code: 'EXPORT_CANCELLED' }),
    ]);
  });

  it('records app-exit cancellation without sending an error terminal event', async () => {
    const taskId = await startExport(windowMock() as never, request);
    await vi.waitFor(() => expect(state.keyframes).toHaveBeenCalledTimes(1));
    await cancelTask(taskId, 'app-exit');
    await waitForTaskEnd(taskId);
    expect(state.events.filter((event) => event.type === 'error')).toEqual([]);
  });

  it('rejects invalid explicit custom ranges before starting FFmpeg work', async () => {
    await expect(startExport(windowMock() as never, {
      ...request,
      selection: {
        mode: 'custom',
        segments: [{ rally_id: 'missing', start_time_seconds: 1, end_time_seconds: 2 }],
      },
    })).rejects.toThrow('INVALID_CUSTOM_SEGMENTS');
    expect(state.keyframes).not.toHaveBeenCalled();
  });
});
