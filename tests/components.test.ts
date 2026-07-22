import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const mediaMock = vi.hoisted(() => ({ x264Valid: true }));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
  },
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

import { resolveUsableMediaComponents } from '../src/main/components';

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
