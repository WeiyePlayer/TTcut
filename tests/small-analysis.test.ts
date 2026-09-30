import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { AppEvent } from '../src/shared/api';
import { smallResult } from './fixtures/small-result';

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(), probe: vi.fn(), worker: vi.fn(), save: vi.fn(),
  begin: vi.fn(), end: vi.fn(), prepare: vi.fn(), remove: vi.fn(),
}));
vi.mock('../src/main/small-components', () => ({ resolveSmallComponents: mocks.resolve }));
vi.mock('../src/main/probe', () => ({ probeVideo: mocks.probe }));
vi.mock('../src/main/analysis-worker', () => ({ runWorker: mocks.worker }));
vi.mock('../src/main/logger', () => ({ logLine: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/main/processes', () => ({ beginTrackedTask: mocks.begin, endTrackedTask: mocks.end, hasActiveTasks: () => false }));
vi.mock('../src/main/history', () => ({ getHistoryStore: () => ({ upsert: mocks.save, hasProcessingMediaReference: async () => false }) }));
vi.mock('../src/main/processing-media', () => ({
  CfrNormalizationError: class extends Error { constructor(public code: string, message: string, public cancelled = false) { super(message); } },
  prepareProcessingMedia: mocks.prepare, removeProcessingCache: mocks.remove,
  targetFrameRateRatio: () => '60000/1001',
  retainOriginalVfrMedia: (metadata: unknown) => ({ metadata, mode: 'original_vfr', targetFpsRatio: null,
    encoder: null, warningCode: null, cachePath: null, cacheKey: null, cacheCreated: false }),
}));

import { startSmallAnalysis } from '../src/main/small-analysis';

describe('Small Main task integration', () => {
  const input = { analysisBackend: 'mobilenet_small' as const, videoPath: 'C:/video/small.mp4',
    device: 'auto' as const, historyVisibility: 'visible' as const, normalizeVariableFrameRate: false };
  let controller: { signal: AbortSignal; cancelRequested: boolean };
  let events: AppEvent[];
  let window: BrowserWindow;
  beforeEach(() => {
    vi.clearAllMocks();
    controller = { signal: new AbortController().signal, cancelRequested: false };
    events = [];
    window = { isDestroyed: () => false, webContents: { send: (_channel: string, event: AppEvent) => events.push(event) } } as unknown as BrowserWindow;
    mocks.resolve.mockResolvedValue({ root: 'E:/MobileNetV3-Large', python: 'E:/MobileNetV3-Large/.venv-training/Scripts/python.exe',
      worker: 'D:/TTcut/worker', media: { ffmpeg: 'D:/media/ffmpeg.exe', ffprobe: 'D:/media/ffprobe.exe', mediaEncoder: 'libx264' } });
    mocks.probe.mockResolvedValue(smallResult().video);
    mocks.begin.mockReturnValue(controller);
    mocks.prepare.mockResolvedValue({ metadata: smallResult().video, mode: 'source_cfr',
      targetFpsRatio: null, encoder: null, warningCode: null, cachePath: null, cacheKey: null, cacheCreated: false });
    mocks.worker.mockImplementation(async options => {
      options.onProgress({ stage: 'analysis', percent: 50, current: 500, total: 1000 });
      return smallResult();
    });
    mocks.save.mockResolvedValue({ id: 'saved-small' });
    mocks.remove.mockResolvedValue(undefined);
  });

  it('launches the source Python and saves a no-calibration result with progress', async () => {
    const taskId = await startSmallAnalysis(window, input);
    await vi.waitFor(() => expect(mocks.end).toHaveBeenCalledWith(taskId));
    const call = mocks.worker.mock.calls[0]![0];
    expect(call.executable).toContain('.venv-training');
    expect(call.args).toEqual(['-B', '-m', 'ttcut_worker.mobilenet_small']);
    expect(call.request).not.toHaveProperty('calibration_choice');
    expect(call.request.video_metadata.fps).toBe(59.94);
    expect(call.request.sampling_fps).toBe(6);
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ schema_version: 4 }), undefined, true);
    expect(events.some(e => e.type === 'progress' && e.data.percent > 0 && e.data.percent < 100)).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'analysis-result', analysisId: 'saved-small' });
    expect(events.at(-1)).not.toHaveProperty('calibration');
  });

  it('does not launch or occupy the task slot when Small resources are missing', async () => {
    mocks.resolve.mockRejectedValue(new Error('SMALL_RESOURCE_MISSING'));
    await expect(startSmallAnalysis(window, input)).rejects.toThrow('SMALL_RESOURCE_MISSING');
    expect(mocks.begin).not.toHaveBeenCalled();
    expect(mocks.worker).not.toHaveBeenCalled();
  });

  it('does not save a cancelled result and releases the task slot', async () => {
    mocks.worker.mockImplementation(async () => { controller.cancelRequested = true; return smallResult(); });
    const id = await startSmallAnalysis(window, input);
    await vi.waitFor(() => expect(mocks.end).toHaveBeenCalledWith(id));
    expect(mocks.save).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'ANALYSIS_CANCELLED' });
  });

  it('preserves original VFR by default without running normalization', async () => {
    mocks.probe.mockResolvedValue({ ...smallResult().video, variable_frame_rate: true });
    const id = await startSmallAnalysis(window, input);
    await vi.waitFor(() => expect(mocks.end).toHaveBeenCalledWith(id));
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.save.mock.calls[0]![0].processing.mode).toBe('original_vfr');
  });

  it('records explicit VFR fallback when opted-in normalization fails', async () => {
    mocks.probe.mockResolvedValue({ ...smallResult().video, variable_frame_rate: true });
    mocks.prepare.mockRejectedValue(new Error('ffmpeg failed'));
    const id = await startSmallAnalysis(window, { ...input, normalizeVariableFrameRate: true });
    await vi.waitFor(() => expect(mocks.end).toHaveBeenCalledWith(id));
    expect(mocks.save.mock.calls[0]![0].processing).toMatchObject({ mode: 'vfr_fallback', warning_code: 'CFR_TRANSCODE_FAILED' });
  });
});
