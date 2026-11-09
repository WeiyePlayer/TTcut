import { access, chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ videos: '' }));

vi.mock('electron', () => ({
  app: { getPath: vi.fn((name: string) => (name === 'videos' ? state.videos : '')) },
}));

vi.mock('../src/main/logger', () => ({
  logLine: vi.fn().mockResolvedValue(undefined),
}));

import { resolveWritableOutputDirectory } from '../src/main/output-location';
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
});
