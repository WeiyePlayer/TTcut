import { beforeAll as beforeWindowsSuite, afterAll as afterWindowsSuite } from 'vitest';
const actualPlatform = process.platform;
beforeWindowsSuite(() => Object.defineProperty(process, 'platform', { value: 'win32' }));
afterWindowsSuite(() => Object.defineProperty(process, 'platform', { value: actualPlatform }));
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const appMock = vi.hoisted(() => ({
  root: '',
  isPackaged: false,
  getAppPath: (): string => appMock.root,
  getPath: () => process.cwd(),
}));

vi.mock('electron', () => ({ app: appMock }));
vi.mock('../src/main/processes', () => ({
  runProcess: vi.fn(async (executable: string, args: readonly string[]) => {
    if (args[0] === '-version') return { stdout: `${path.basename(executable, '.exe')} version bundled-x264\n`, stderr: '', code: 0 };
    if (args[0] === '-buildconf') return { stdout: '--enable-libx264', stderr: '', code: 0 };
    return { stdout: ' V..... libx264 H.264 / AVC\n V..... libx265 HEVC\n', stderr: '', code: 0 };
  }),
}));

import { resolveComponents, resolveUsableMediaComponents } from '../src/main/components';

let root = '';
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'ttcut-components-'));
  appMock.root = root;
  const mediaRoot = path.join(root, '.runtime', 'windows', 'ffmpeg');
  await mkdir(mediaRoot, { recursive: true });
  for (const name of ['ffmpeg.exe', 'ffprobe.exe']) await writeFile(path.join(mediaRoot, name), 'fixture');
});
afterAll(async () => {
  delete process.env.TTCUT_ENABLE_LOCAL_TRACKNET;
  delete process.env.TTCUT_TRACKNET_WEIGHTS;
  await rm(root, { recursive: true, force: true });
});

describe('bundled production components', () => {
  it('resolves ONNX models, the bundled Python runtime, and x264 only', async () => {
    const components = await resolveComponents();
    expect(components.python).toBe(path.join(root, '.runtime', 'windows', 'python', 'python.exe'));
    expect(components.blurballWeights).toBe(path.join(root, 'resources', 'models', 'blurball_best.onnx'));
    expect(components.tableAnalyzeWeights).toBe(path.join(root, 'resources', 'models', 'table_analyze.onnx'));
    expect(components.mediaEncoder).toBe('libx264');

    const media = await resolveUsableMediaComponents();
    expect(media.mediaEncoder).toBe('libx264');
    expect(media.ffmpeg).toBe(path.join(root, '.runtime', 'windows', 'ffmpeg', 'ffmpeg.exe'));
  });
});

describe('local TrackNet development weight lookup', () => {
  it('requires explicit development opt-in and is disabled for packaged builds', async () => {
    const weight = path.join(root, 'TrackNet_best.pt');
    const originalResourcesPath = process.resourcesPath;
    await writeFile(weight, 'local-test-only');
    process.env.TTCUT_TRACKNET_WEIGHTS = weight;
    try {
      expect((await resolveComponents()).tracknetWeights).toBeNull();
      process.env.TTCUT_ENABLE_LOCAL_TRACKNET = '1';
      expect((await resolveComponents()).tracknetWeights).toBe(path.resolve(weight));
      appMock.isPackaged = true;
      Object.defineProperty(process, 'resourcesPath', { configurable: true, value: root });
      expect((await resolveComponents()).tracknetWeights).toBeNull();
    } finally {
      appMock.isPackaged = false;
      Object.defineProperty(process, 'resourcesPath', { configurable: true, value: originalResourcesPath });
      delete process.env.TTCUT_ENABLE_LOCAL_TRACKNET;
      delete process.env.TTCUT_TRACKNET_WEIGHTS;
    }
  });
});
