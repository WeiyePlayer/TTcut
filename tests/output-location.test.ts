import { access, chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ videos: '', probeFailures: new Map<string, string>() }));

// Errors such as ENOSPC cannot be produced on demand by a real filesystem, so probe opens in a
// listed directory fail with that errno; everything else reaches the real filesystem.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const open = ((file: string, ...rest: unknown[]) => {
    const code = state.probeFailures.get(String(file).slice(0, String(file).lastIndexOf(path.sep)));
    if (code) return Promise.reject(Object.assign(new Error(code), { code }));
    return (actual.open as (...args: unknown[]) => unknown)(file, ...rest);
  }) as typeof actual.open;
  return { ...actual, open, default: { ...actual, open } };
});

vi.mock('electron', () => ({
  app: { getPath: vi.fn((name: string) => (name === 'videos' ? state.videos : '')) },
}));

vi.mock('../src/main/logger', () => ({
  logLine: vi.fn().mockResolvedValue(undefined),
}));

import { defaultSaveDialogDirectory, resolveWritableOutputDirectory, writeProbeFailure } from '../src/main/output-location';
import { logLine } from '../src/main/logger';

// chmod cannot make a directory read-only on Windows, and root ignores mode bits.
const readOnlyDirectoriesEnforced = process.platform !== 'win32' && process.getuid?.() !== 0;

describe('resolveWritableOutputDirectory', () => {
  let root: string;
  let sourceDirectory: string;
  let source: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'ttcut-output-location-'));
    sourceDirectory = path.join(root, 'source');
    await mkdir(sourceDirectory);
    source = path.join(sourceDirectory, '杜比视界.mp4');
    await writeFile(source, 'source');
    state.videos = path.join(root, 'Movies');
    state.probeFailures.clear();
    vi.mocked(logLine).mockClear();
  });

  afterEach(async () => {
    await chmod(sourceDirectory, 0o755).catch(() => undefined);
    await chmod(state.videos, 0o755).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  it('keeps the source directory when it is writable and leaves no probe behind', async () => {
    await expect(resolveWritableOutputDirectory(source)).resolves.toBe(sourceDirectory);
    expect(await readdir(sourceDirectory)).toEqual(['杜比视界.mp4']);
    await expect(access(path.join(state.videos, 'TTcut'))).rejects.toThrow();
    expect(logLine).not.toHaveBeenCalled();
  });

  it.skipIf(!readOnlyDirectoriesEnforced)('falls back to Movies/TTcut when the source directory is read-only', async () => {
    await chmod(sourceDirectory, 0o555);
    const fallback = path.join(state.videos, 'TTcut');

    await expect(resolveWritableOutputDirectory(source, 'task-1')).resolves.toBe(fallback);
    await expect(access(fallback)).resolves.toBeUndefined();
    expect(await readdir(fallback)).toEqual([]);
    expect(logLine).toHaveBeenCalledWith(
      'task-1',
      'INFO',
      `Export output directory fallback: ${sourceDirectory} -> ${fallback}`,
    );
  });

  it.skipIf(!readOnlyDirectoriesEnforced)('reports OUTPUT_DIRECTORY_UNWRITABLE when the fallback is unwritable too', async () => {
    await chmod(sourceDirectory, 0o555);
    await mkdir(state.videos);
    await chmod(state.videos, 0o555);

    await expect(resolveWritableOutputDirectory(source)).rejects.toThrow('OUTPUT_DIRECTORY_UNWRITABLE');
  });

  it('does not fall back when the source directory no longer exists', async () => {
    const moved = path.join(root, 'moved', 'source.mp4');

    await expect(resolveWritableOutputDirectory(moved)).resolves.toBe(path.dirname(moved));
    await expect(access(path.join(state.videos, 'TTcut'))).rejects.toThrow();
  });

  it('falls back to Movies/TTcut when the source volume is full', async () => {
    state.probeFailures.set(sourceDirectory, 'ENOSPC');
    const fallback = path.join(state.videos, 'TTcut');

    await expect(resolveWritableOutputDirectory(source)).resolves.toBe(fallback);
  });

  it.each(['ENOSPC', 'EACCES'])('reports DISK_SPACE_LOW when the source volume is full and the fallback fails with %s', async (code) => {
    state.probeFailures.set(sourceDirectory, 'ENOSPC');
    state.probeFailures.set(path.join(state.videos, 'TTcut'), code);

    await expect(resolveWritableOutputDirectory(source)).rejects.toThrow('DISK_SPACE_LOW');
  });

  it('reports DISK_SPACE_LOW when the source is unwritable and the fallback volume is full', async () => {
    state.probeFailures.set(sourceDirectory, 'EACCES');
    state.probeFailures.set(path.join(state.videos, 'TTcut'), 'ENOSPC');

    await expect(resolveWritableOutputDirectory(source)).rejects.toThrow('DISK_SPACE_LOW');
  });
});

describe('defaultSaveDialogDirectory', () => {
  let root: string;
  let sourceDirectory: string;
  let source: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'ttcut-dialog-default-'));
    sourceDirectory = path.join(root, 'source');
    await mkdir(sourceDirectory);
    source = path.join(sourceDirectory, 'clip.mp4');
    await writeFile(source, 'source');
    state.videos = path.join(root, 'Movies');
    state.probeFailures.clear();
    vi.mocked(logLine).mockClear();
  });

  afterEach(async () => {
    await chmod(state.videos, 0o755).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  it('suggests the source directory when it is writable', async () => {
    await expect(defaultSaveDialogDirectory(source)).resolves.toBe(sourceDirectory);
    expect(await readdir(sourceDirectory)).toEqual(['clip.mp4']);
    await expect(access(state.videos)).rejects.toThrow();
  });

  it('suggests Movies/TTcut when the source directory is unwritable', async () => {
    state.probeFailures.set(sourceDirectory, 'EACCES');
    await expect(defaultSaveDialogDirectory(source)).resolves.toBe(path.join(state.videos, 'TTcut'));
    expect(logLine).not.toHaveBeenCalled();
  });

  it.skipIf(!readOnlyDirectoriesEnforced)('suggests the source directory instead of throwing when the fallback cannot be created', async () => {
    state.probeFailures.set(sourceDirectory, 'EACCES');
    await mkdir(state.videos);
    await chmod(state.videos, 0o555);
    await expect(defaultSaveDialogDirectory(source)).resolves.toBe(sourceDirectory);
  });

  it('suggests the existing fallback even when its volume is full', async () => {
    state.probeFailures.set(sourceDirectory, 'ENOSPC');
    await mkdir(path.join(state.videos, 'TTcut'), { recursive: true });
    state.probeFailures.set(path.join(state.videos, 'TTcut'), 'ENOSPC');
    await expect(defaultSaveDialogDirectory(source)).resolves.toBe(path.join(state.videos, 'TTcut'));
  });
});

describe('writeProbeFailure', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'ttcut-write-probe-'));
    state.probeFailures.clear();
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('returns null for a writable directory and leaves no probe behind', async () => {
    await expect(writeProbeFailure(directory)).resolves.toBeNull();
    expect(await readdir(directory)).toEqual([]);
  });

  it('returns the errno of a rejected probe', async () => {
    state.probeFailures.set(directory, 'ENOSPC');
    await expect(writeProbeFailure(directory)).resolves.toBe('ENOSPC');
    await expect(writeProbeFailure(path.join(directory, 'missing'))).resolves.toBe('ENOENT');
  });
});
