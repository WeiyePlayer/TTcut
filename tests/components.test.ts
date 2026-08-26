import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const mediaMock = vi.hoisted(() => ({ x264Valid: true }));
const appMock = vi.hoisted(() => ({
  isPackaged: false,
  getAppPath: () => process.cwd(),
  getPath: () => process.cwd(),
}));
const installationMock = vi.hoisted(() => ({
  localForgePackage: false,
  layout: {
    root: '',
    appRoot: '',
    componentRoot: '',
    userDataRoot: '',
  },
}));

vi.mock('electron', () => ({
  app: appMock,
}));

vi.mock('../src/main/installation-layout', () => ({
  isLocalForgePackage: () => installationMock.localForgePackage,
  resolveInstallationLayout: () => installationMock.layout,
}));

vi.mock('../src/main/processes', () => ({
  runProcess: vi.fn(async (executable: string, args: readonly string[]) => {
    const x264 = executable.includes('ffmpeg-x264-');
    const version = x264
      ? 'N-125716-g1b1f602699-20260722'
      : 'n8.1.2-22-g94138f6973-20260717';
    if (args[0] === '-version') {
      return { stdout: `ffmpeg version ${x264 && !mediaMock.x264Valid ? 'invalid' : version}\n`, stderr: '', code: 0 };
    }
    if (args[0] === '-buildconf') {
      return {
        stdout: x264
          ? '--enable-gpl --enable-version3 --enable-libx264'
          : '--enable-shared --enable-libopenh264 --disable-libx264 --disable-libx265',
        stderr: '',
        code: 0,
      };
    }
    return {
      stdout: x264 ? 'libx264 aac' : 'libopenh264 aac',
      stderr: '',
      code: 0,
    };
  }),
}));

import { resolveComponents, resolveUsableMediaComponents } from '../src/main/components';

let root = '';

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'ttcut-media-components-'));
  process.env.TTCUT_E2E = '1';
  process.env.TTCUT_E2E_COMPONENTS_ROOT = root;
  delete process.env.TTCUT_FFMPEG;
  delete process.env.TTCUT_FFPROBE;
  for (const installDirectory of ['ffmpeg-x264-N-125716-g1b1f602699', 'ffmpeg-8.1']) {
    const bin = path.join(root, installDirectory, 'bin');
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, 'ffmpeg.exe'), 'test');
    await writeFile(path.join(bin, 'ffprobe.exe'), 'test');
  }
});

afterAll(async () => {
  delete process.env.TTCUT_E2E;
  delete process.env.TTCUT_E2E_COMPONENTS_ROOT;
  await rm(root, { recursive: true, force: true });
});

describe('media component selection', () => {
  it('prefers a valid x264 component and falls back to OpenH264 if x264 becomes invalid', async () => {
    mediaMock.x264Valid = true;
    const preferred = await resolveUsableMediaComponents();
    expect(preferred.mediaEncoder).toBe('libx264');
    expect(preferred.ffmpeg).toContain('ffmpeg-x264-N-125716-g1b1f602699');

    mediaMock.x264Valid = false;
    const fallback = await resolveUsableMediaComponents();
    expect(fallback.mediaEncoder).toBe('libopenh264');
    expect(fallback.ffmpeg).toContain('ffmpeg-8.1');
  });
});

describe('packaged model lookup', () => {
  it('reuses models from the registered installation when an unpacked Forge build reuses its component store', async () => {
    const packageResources = await mkdtemp(path.join(os.tmpdir(), 'ttcut-forge-package-resources-'));
    const installedRoot = await mkdtemp(path.join(os.tmpdir(), 'ttcut-registered-install-'));
    const installedModels = path.join(installedRoot, 'app', 'resources', 'resources', 'models');
    const originalExecPath = process.execPath;
    const originalResourcesPath = process.resourcesPath;
    await mkdir(installedModels, { recursive: true });
    await writeFile(path.join(installedModels, 'blurball_best.pt'), 'blurball');
    await writeFile(path.join(installedModels, 'table_analyze.pt'), 'table');
    Object.defineProperty(process, 'resourcesPath', { configurable: true, value: packageResources });
    Object.defineProperty(process, 'execPath', {
      configurable: true,
      value: path.join(process.cwd(), 'out', 'TTcut-win32-x64', 'TTcut.exe'),
    });
    appMock.isPackaged = true;
    installationMock.localForgePackage = true;
    installationMock.layout = {
      root: installedRoot,
      appRoot: path.join(installedRoot, 'app'),
      componentRoot: root,
      userDataRoot: installedRoot,
    };

    try {
      const components = await resolveComponents();
      expect(components.blurballWeights).toBe(path.join(installedModels, 'blurball_best.pt'));
      expect(components.tableAnalyzeWeights).toBe(path.join(installedModels, 'table_analyze.pt'));
    } finally {
      appMock.isPackaged = false;
      installationMock.localForgePackage = false;
      installationMock.layout = { root: '', appRoot: '', componentRoot: '', userDataRoot: '' };
      Object.defineProperty(process, 'execPath', { configurable: true, value: originalExecPath });
      Object.defineProperty(process, 'resourcesPath', { configurable: true, value: originalResourcesPath });
      await rm(packageResources, { recursive: true, force: true });
      await rm(installedRoot, { recursive: true, force: true });
    }
  });
});
