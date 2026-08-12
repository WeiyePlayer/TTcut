import { access, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
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
    terminalTaskActive: [] as boolean[],
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
    markVisible: vi.fn(),
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
        }, {
          id: 'rally_002',
          index: 2,
          bounce_count: 6,
          start_time_seconds: 16,
          end_time_seconds: 18,
        }],
      } satisfies AnalysisResultV1,
    })),
    markVisible: state.markVisible,
  }),
}));

import { startExport } from '../src/main/export';
import { resolveUsableMediaComponents } from '../src/main/components';
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
      send: (_channel: string, event: AppEvent) => {
        state.events.push(event);
        if (event.type === 'error' || event.type === 'export-result') {
          state.terminalTaskActive.push(Boolean(getTaskController(event.taskId)));
        }
      },
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
    state.terminalTaskActive.length = 0;
    state.keyframes.mockClear();
    state.markVisible.mockClear();
    vi.mocked(resolveUsableMediaComponents).mockClear();
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
    expect(state.terminalTaskActive).toEqual([false]);
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

  it('rejects custom artifact outputs for non-custom selections in Main', async () => {
    await expect(startExport(windowMock() as never, {
      ...request,
      outputs: { combined_video: false, rally_videos: false, premiere_xml: true },
    })).rejects.toThrow('INVALID_EXPORT_OUTPUTS');
    expect(state.keyframes).not.toHaveBeenCalled();
  });

  it('writes XML-only custom artifacts without resolving media components or changing history', async () => {
    const taskId = await startExport(windowMock() as never, {
      analysis_id: request.analysis_id,
      selection: {
        mode: 'custom',
        segments: [{ rally_id: 'rally_001', start_time_seconds: 8, end_time_seconds: 14 }],
      },
      destination: 'source',
      outputs: { combined_video: false, rally_videos: false, premiere_xml: true },
    });
    await waitForTaskEnd(taskId);

    const result = state.events.find((event): event is Extract<AppEvent, { type: 'export-result' }> => event.type === 'export-result');
    expect(result?.data).toMatchObject({
      kind: 'custom-artifacts',
      partialSuccess: false,
      rallyVideos: [],
      failedRallies: [],
      premiereXml: { quantizedForVfr: false },
    });
    if (!result || result.data.kind !== 'custom-artifacts') throw new Error('Missing custom artifact result');
    await expect(access(result.data.premiereXml!.outputPath)).resolves.toBeUndefined();
    expect((await readdir(result.data.outputDirectory)).filter((name) => name.endsWith('.xml'))).toHaveLength(1);
    expect(state.keyframes).not.toHaveBeenCalled();
    expect(state.markVisible).not.toHaveBeenCalled();
    expect(resolveUsableMediaComponents).not.toHaveBeenCalled();
  });

  it('uses an incrementing directory for repeated custom artifact exports', async () => {
    const customRequest: ExportRequest = {
      analysis_id: request.analysis_id,
      selection: { mode: 'custom', segments: [{ rally_id: 'rally_001', start_time_seconds: 8, end_time_seconds: 14 }] },
      destination: 'source',
      outputs: { combined_video: false, rally_videos: false, premiere_xml: true },
    };
    const firstTask = await startExport(windowMock() as never, customRequest);
    await waitForTaskEnd(firstTask);
    const secondTask = await startExport(windowMock() as never, customRequest);
    await waitForTaskEnd(secondTask);
    const directories = state.events
      .filter((event): event is Extract<AppEvent, { type: 'export-result' }> => event.type === 'export-result')
      .flatMap((event) => event.data.kind === 'custom-artifacts' ? [event.data.outputDirectory] : []);
    expect(directories).toHaveLength(2);
    expect(directories[1]).toMatch(/_2$/);
  });

  it('retains XML and reports partial success when a rally video fails', async () => {
    const taskId = await startExport(windowMock() as never, {
      analysis_id: request.analysis_id,
      selection: {
        mode: 'custom',
        segments: [{ rally_id: 'rally_001', start_time_seconds: 8, end_time_seconds: 14 }],
      },
      destination: 'source',
      outputs: { combined_video: false, rally_videos: true, premiere_xml: true },
    });
    await vi.waitFor(() => expect(state.keyframes).toHaveBeenCalledTimes(1));
    state.release([0]);
    await waitForTaskEnd(taskId);

    const result = state.events.find((event): event is Extract<AppEvent, { type: 'export-result' }> => event.type === 'export-result');
    expect(result?.data).toMatchObject({
      kind: 'custom-artifacts',
      partialSuccess: true,
      rallyVideos: [],
      failedRallies: [{ rallyId: 'rally_001', rallyIndex: 1 }],
      premiereXml: { quantizedForVfr: false },
    });
  });

  it('removes all artifact files when the user cancels', async () => {
    const taskId = await startExport(windowMock() as never, {
      analysis_id: request.analysis_id,
      selection: {
        mode: 'custom',
        segments: [{ rally_id: 'rally_001', start_time_seconds: 8, end_time_seconds: 14 }],
      },
      destination: 'source',
      outputs: { combined_video: false, rally_videos: true, premiere_xml: true },
    });
    await vi.waitFor(() => expect(state.keyframes).toHaveBeenCalledTimes(1));
    await cancelTask(taskId, 'user');
    await waitForTaskEnd(taskId);

    expect(await readdir(directory)).toEqual(['source.mp4']);
  });
});
