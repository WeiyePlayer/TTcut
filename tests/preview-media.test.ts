import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ probe: vi.fn(), run: vi.fn(), components: vi.fn(), log: vi.fn(), temp: '' }));
vi.mock('electron', () => ({ app: { getPath: () => mocks.temp } }));
vi.mock('../src/main/probe', () => ({ probeVideo: mocks.probe }));
vi.mock('../src/main/processes', () => ({ runProcess: mocks.run }));
vi.mock('../src/main/components', () => ({ resolveUsableMediaComponents: mocks.components }));
vi.mock('../src/main/logger', () => ({ logLine: mocks.log }));
let source: string;
let service: typeof import('../src/main/preview-media');

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.log.mockResolvedValue(undefined);
  mocks.temp = await mkdtemp(path.join(os.tmpdir(), 'ttcut-preview-test-'));
  source = path.join(mocks.temp, 'source.mov');
  await writeFile(source, 'original');
  mocks.components.mockResolvedValue({ ffmpeg: 'ffmpeg', mediaEncoder: 'libx264' });
  mocks.probe.mockImplementation(async (file: string) => ({
    path: file, duration_seconds: 10, width: file === source ? 3840 : 1280, height: file === source ? 2160 : 720,
    fps: 60, video_codec: file === source ? 'hevc' : 'h264', pixel_format: 'yuv420p', audio_codec: 'aac',
  }));
  mocks.run.mockImplementation(async (_exe, args: string[]) => {
    await writeFile(args.at(-1)!, 'proxy');
    return { code: 0, stdout: '', stderr: '' };
  });
  service = await import('../src/main/preview-media');
});
afterEach(async () => {
  await service.disposePreviewMedia();
  await rm(mocks.temp, { recursive: true, force: true });
});

describe('compatible preview media', () => {
  it('does not fail a usable preview when diagnostic logging is unavailable', async () => {
    mocks.log.mockRejectedValue(new Error('log volume unavailable'));
    await expect(service.preparePreviewMedia(source)).resolves.toMatch(/\.mp4$/);
  });
  it('shares concurrent requests, caches by source identity and leaves the source intact', async () => {
    const [first, second] = await Promise.all([service.preparePreviewMedia(source), service.preparePreviewMedia(source)]);
    expect(first).toBe(second);
    expect(first).not.toBe(source);
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(mocks.run.mock.calls[0]![1]).toEqual(expect.arrayContaining(['0:v:0', '0:a:0?', 'libx264', 'yuv420p', '4.2']));
    await writeFile(source, 'changed original');
    expect(await service.preparePreviewMedia(source)).not.toBe(first);
    expect(mocks.run).toHaveBeenCalledTimes(2);
  });

  it('removes partial output after failure and permits a retry', async () => {
    mocks.run.mockImplementationOnce(async (_exe, args: string[]) => {
      await writeFile(args.at(-1)!, 'partial');
      throw new Error('encoder failed');
    });
    await expect(service.preparePreviewMedia(source)).rejects.toThrow('encoder failed');
    const cache = (await readdir(mocks.temp)).find((entry) => entry.startsWith('ttcut-preview-'))!;
    expect(await readdir(path.join(mocks.temp, cache))).toEqual([]);
    await expect(service.preparePreviewMedia(source)).resolves.toMatch(/\.mp4$/);
  });

  it('rejects truncated output instead of returning an incomplete timeline', async () => {
    mocks.probe.mockImplementation(async (file: string) => ({
      path: file, duration_seconds: file === source ? 10 : 2, width: 1280, height: 720,
      fps: 60, video_codec: 'h264', pixel_format: 'yuv420p', audio_codec: 'aac',
    }));
    await expect(service.preparePreviewMedia(source)).rejects.toThrow('PREVIEW_VALIDATION_FAILED');
  });

  it('aborts preparation and deletes its cache before shutdown completes', async () => {
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    mocks.run.mockImplementation((_exe, _args, { signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      started();
    }));
    const preview = service.preparePreviewMedia(source);
    const rejected = expect(preview).rejects.toThrow('cancelled');
    await running;
    await service.disposePreviewMedia();
    await rejected;
    expect(await readdir(mocks.temp)).toEqual(['source.mov']);
    expect(service.hasPreviewMedia()).toBe(false);
    await expect(service.preparePreviewMedia(source)).rejects.toThrow('PREVIEW_CANCELLED');
  });
});
