import { EventEmitter } from 'node:events';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VideoMetadata } from '../src/shared/contracts';

const mocks = vi.hoisted(() => ({
  componentsRoot: '',
  probe: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('../src/main/components', () => ({
  managedComponentsRoot: () => mocks.componentsRoot,
}));
vi.mock('../src/main/probe', () => ({ probeVideo: mocks.probe }));
vi.mock('../src/main/processes', () => ({
  getTaskController: () => undefined,
  spawnTracked: mocks.spawn,
}));

let directory: string;
let sourcePath: string;
let service: typeof import('../src/main/processing-media');

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  directory = await mkdtemp(path.join(os.tmpdir(), 'ttcut-processing-media-test-'));
  mocks.componentsRoot = path.join(directory, 'components');
  sourcePath = path.join(directory, 'source.mp4');
  await writeFile(sourcePath, 'source video');

  mocks.probe.mockImplementation(async (file: string): Promise<VideoMetadata> => ({
    path: file,
    duration_seconds: 10,
    width: 1920,
    height: 1080,
    fps: 30,
    frame_count: 300,
    variable_frame_rate: false,
    nominal_fps: 30,
    nominal_fps_ratio: '30/1',
    average_fps_ratio: '30/1',
    video_codec: 'h264',
    audio_codec: 'aac',
    container: 'mp4',
  }));
  mocks.spawn.mockImplementation((_taskId: string, _executable: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      killed: boolean;
      kill: ReturnType<typeof vi.fn>;
      stdin: { end: () => void };
      stdout: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
      stderr: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
    };
    child.killed = false;
    child.kill = vi.fn();
    child.stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
    child.stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
    child.stdin = {
      end: () => {
        void writeFile(args.at(-1)!, Buffer.alloc(2048)).then(() => child.emit('close', 0, null));
      },
    };
    return child;
  });
  service = await import('../src/main/processing-media');
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('processing media publication', () => {
  it('returns the published cache path after creating normalized media', async () => {
    const source: VideoMetadata = {
      path: sourcePath,
      duration_seconds: 10,
      width: 1920,
      height: 1080,
      fps: 30,
      frame_count: 300,
      variable_frame_rate: true,
      nominal_fps: 30,
      nominal_fps_ratio: '30/1',
      average_fps_ratio: '30/1',
      video_codec: 'h264',
      audio_codec: 'aac',
      container: 'mp4',
    };

    const result = await service.prepareProcessingMedia(
      'task-1',
      source,
      'libx264',
      'ffmpeg',
      new AbortController().signal,
      vi.fn(),
    );

    expect(result.metadata.path).toBe(result.cachePath);
    expect(result.metadata.path).not.toContain('.partial');
    await expect(stat(result.metadata.path)).resolves.toMatchObject({ size: 2048 });

    const cached = await service.prepareProcessingMedia(
      'task-2',
      source,
      'libx264',
      'ffmpeg',
      new AbortController().signal,
      vi.fn(),
    );
    expect(cached.metadata.path).toBe(result.metadata.path);
    expect(cached.cacheCreated).toBe(false);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });
});
