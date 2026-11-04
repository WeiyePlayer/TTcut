import { mkdtemp, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VideoMetadata } from '../src/shared/contracts';

const mocks = vi.hoisted(() => ({ probe: vi.fn(), run: vi.fn(), components: vi.fn(), log: vi.fn(), temp: '' }));
vi.mock('electron', () => ({ app: { getPath: () => mocks.temp } }));
vi.mock('../src/main/probe', () => ({ probeVideo: mocks.probe }));
vi.mock('../src/main/processes', () => ({ runProcess: mocks.run }));
vi.mock('../src/main/components', () => ({ resolveUsableMediaComponents: mocks.components }));
vi.mock('../src/main/logger', () => ({ logLine: mocks.log }));

const metadata: VideoMetadata = {
  path: 'source.mov', duration_seconds: 10, width: 3840, height: 2160,
  fps: 60, variable_frame_rate: false, video_codec: 'hevc', audio_codec: null, container: 'mov',
};
let source: string;
let service: typeof import('../src/main/preview-frame');

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.log.mockResolvedValue(undefined);
  mocks.temp = await mkdtemp(path.join(os.tmpdir(), 'ttcut-frame-test-'));
  source = path.join(mocks.temp, 'source.mov');
  await writeFile(source, 'original');
  // JPEG extraction does not require the H.264 proxy encoder.
  mocks.components.mockResolvedValue({ ffmpeg: 'ffmpeg', mediaEncoder: 'unavailable' });
  mocks.probe.mockResolvedValue(metadata);
  mocks.run.mockImplementation(async (_exe, args: string[]) => {
    await writeFile(args.at(-1)!, 'jpeg');
    return { code: 0, stdout: '', stderr: '' };
  });
  service = await import('../src/main/preview-frame');
});

afterEach(async () => {
  await service.disposePreviewFrames();
  await rm(mocks.temp, { recursive: true, force: true });
});

describe('calibration preview frames', () => {
  it('seeks before opening the input, extracts one JPEG and retains default autorotate', () => {
    const args = service.buildPreviewFrameArgs(source, 'frame.jpg', 12.5, metadata);
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    expect(args[args.indexOf('-ss') + 1]).toBe('12.5');
    expect(args[args.indexOf('-frames:v') + 1]).toBe('1');
    expect(args[args.indexOf('-vf') + 1]).toBe('scale=1280:720:force_original_aspect_ratio=decrease:out_range=tv');
    expect(args).toEqual(expect.arrayContaining(['-an', '-sn', '-dn', '-update', '1', '-q:v', '3']));
    expect(args).not.toContain('-noautorotate');
    expect(args.at(-1)).toBe('frame.jpg');
  });

  it.each(['smpte2084', 'arib-std-b67'])('shares the existing HDR tone filter for %s', async (color_transfer) => {
    const { previewToneFilter, buildPreviewArgs } = await import('../src/main/preview-media');
    const hdr = { ...metadata, color_transfer };
    const tone = previewToneFilter(hdr);
    expect(tone).toContain('tonemap=hable');
    const frame = service.buildPreviewFrameArgs(source, 'frame.jpg', 0, hdr);
    const proxy = buildPreviewArgs(source, 'proxy.mp4', hdr, 'libx264');
    expect(frame[frame.indexOf('-vf') + 1]!.startsWith(tone)).toBe(true);
    expect(proxy[proxy.indexOf('-vf') + 1]!.startsWith(tone)).toBe(true);
    expect(previewToneFilter(metadata)).toBe('');
  });

  it('caches interactive metadata by source identity and keeps only the latest frame', async () => {
    const first = await service.extractPreviewFrame(source, 0);
    const second = await service.extractPreviewFrame(source, 4);
    expect(first).not.toBe(second);
    expect(mocks.probe).toHaveBeenCalledExactlyOnceWith(source, expect.any(AbortSignal), 'interactive');
    expect(mocks.run).toHaveBeenLastCalledWith('ffmpeg', expect.any(Array), { signal: expect.any(AbortSignal), timeoutMs: 30_000 });
    expect(await readdir(path.dirname(second))).toEqual([path.basename(second)]);
    expect(await readFile(source, 'utf8')).toBe('original');
    await writeFile(source, 'changed original');
    await service.extractPreviewFrame(source, 5);
    expect(mocks.probe).toHaveBeenCalledTimes(2);
    expect(mocks.log).toHaveBeenCalledWith('preview', 'INFO', expect.stringMatching(/Frame ready.*\(\d+ms\)/));
  });

  it('cancels obsolete requests, waits for process exit and publishes only the latest', async () => {
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    let exit!: () => void;
    let activeSignal!: AbortSignal;
    mocks.run.mockImplementationOnce((_exe, _args, { signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      activeSignal = signal;
      exit = () => reject(new Error('process cancelled'));
      started();
    }));
    const first = service.extractPreviewFrame(source, 0);
    const firstCancelled = expect(first).rejects.toThrow('PREVIEW_CANCELLED');
    await running;
    const queued = service.extractPreviewFrame(source, 1);
    const queuedCancelled = expect(queued).rejects.toThrow('PREVIEW_CANCELLED');
    const latest = service.extractPreviewFrame(source, 2);
    await queuedCancelled;
    expect(activeSignal.aborted).toBe(true);
    expect(mocks.run).toHaveBeenCalledTimes(1);
    exit();
    await firstCancelled;
    const output = await latest;
    expect(mocks.run).toHaveBeenCalledTimes(2);
    const args = mocks.run.mock.calls[1]![1] as string[];
    expect(args[args.indexOf('-ss') + 1]).toBe('2');
    expect(await readdir(path.dirname(output))).toEqual([path.basename(output)]);
    expect(mocks.log.mock.calls.filter((call) => call[1] === 'INFO')).toHaveLength(1);
  });

  it('clamps the scrubber endpoint and out-of-range times to the last video frame', async () => {
    mocks.probe.mockResolvedValue({ ...metadata, duration_seconds: 15, video_duration_seconds: 10, fps: 25 });
    await service.extractPreviewFrame(source, 100);
    const args = mocks.run.mock.calls[0]![1] as string[];
    expect(Number(args[args.indexOf('-ss') + 1])).toBeCloseTo(9.96);
  });

  it('removes partial frames on failure and allows retry even when logging fails', async () => {
    mocks.log.mockRejectedValue(new Error('log unavailable'));
    mocks.run.mockImplementationOnce(async (_exe, args: string[]) => {
      await writeFile(args.at(-1)!, 'partial');
      throw new Error('decoder failed');
    });
    await expect(service.extractPreviewFrame(source, 0)).rejects.toThrow('decoder failed');
    const cache = (await readdir(mocks.temp)).find((entry) => entry.startsWith('ttcut-frame-'))!;
    expect(await readdir(path.join(mocks.temp, cache))).toEqual([]);
    await expect(service.extractPreviewFrame(source, 0)).resolves.toMatch(/\.jpg$/);
  });

  it('rejects directories, invalid times and missing FFmpeg without starting extraction', async () => {
    await expect(service.extractPreviewFrame(mocks.temp, 0)).rejects.toThrow('INVALID_INPUT');
    for (const seconds of [-1, NaN, Infinity]) {
      await expect(service.extractPreviewFrame(source, seconds)).rejects.toThrow('INVALID_INPUT');
    }
    mocks.components.mockResolvedValue({ ffmpeg: null });
    await expect(service.extractPreviewFrame(source, 0)).rejects.toThrow('MEDIA_COMPONENT_MISSING');
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('aborts active and queued requests and removes the session directory on disposal', async () => {
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    mocks.run.mockImplementation((_exe, _args, { signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('process cancelled')), { once: true });
      started();
    }));
    const first = service.extractPreviewFrame(source, 0);
    const firstCancelled = expect(first).rejects.toThrow('PREVIEW_CANCELLED');
    await running;
    const queued = service.extractPreviewFrame(source, 1);
    const queuedCancelled = expect(queued).rejects.toThrow('PREVIEW_CANCELLED');
    await service.disposePreviewFrames();
    await Promise.all([firstCancelled, queuedCancelled]);
    expect(await readdir(mocks.temp)).toEqual(['source.mov']);
    expect(service.hasPreviewFrames()).toBe(false);
    await expect(service.extractPreviewFrame(source, 0)).rejects.toThrow('PREVIEW_CANCELLED');
  });
});
