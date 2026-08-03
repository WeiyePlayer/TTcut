import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  dialog: { showSaveDialog: vi.fn() },
}));

import { retainUsableExportOutput } from '../src/main/export';

describe('usable export output recovery', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'ttcut-export-recovery-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('moves a playable partial to the normal output path', async () => {
    const partial = path.join(directory, '.output.partial.mp4');
    const output = path.join(directory, 'output.mp4');
    await writeFile(partial, 'completed output');

    const retained = await retainUsableExportOutput(partial, output, async () => true);

    expect(retained).toEqual({ path: output, renamed: true });
    await expect(access(output)).resolves.toBeUndefined();
    await expect(access(partial)).rejects.toThrow();
  });

  it('uses a collision-safe warning name when the normal output becomes occupied', async () => {
    const partial = path.join(directory, '.output.partial.mp4');
    const output = path.join(directory, 'output.mp4');
    const firstRecovery = path.join(directory, 'output_with_warning.mp4');
    await writeFile(partial, 'completed output');
    await writeFile(output, 'occupied output');
    await writeFile(firstRecovery, 'older recovery');

    const retained = await retainUsableExportOutput(partial, output, async () => true);

    expect(retained).toEqual({ path: path.join(directory, 'output_with_warning_2.mp4'), renamed: true });
    await expect(access(retained!.path)).resolves.toBeUndefined();
    await expect(access(partial)).rejects.toThrow();
  });

  it('keeps the original partial when the visible rename cannot be completed', async () => {
    const partial = path.join(directory, '.output.partial.mp4');
    const output = path.join(directory, 'missing', 'output.mp4');
    await writeFile(partial, 'completed output');

    const retained = await retainUsableExportOutput(partial, output, async () => true);

    expect(retained).toEqual({ path: partial, renamed: false });
    await expect(access(partial)).resolves.toBeUndefined();
  });

  it('does not retain an unreadable partial', async () => {
    const partial = path.join(directory, '.output.partial.mp4');
    const output = path.join(directory, 'output.mp4');
    await writeFile(partial, 'broken output');

    const retained = await retainUsableExportOutput(partial, output, async () => false);

    expect(retained).toBeNull();
    await expect(access(partial)).resolves.toBeUndefined();
  });

  it('recognizes an output that was already moved before a later error', async () => {
    const partial = path.join(directory, '.output.partial.mp4');
    const output = path.join(directory, 'output.mp4');
    await writeFile(output, 'completed output');

    const retained = await retainUsableExportOutput(partial, output, async () => true);

    expect(retained).toEqual({ path: output, renamed: false });
  });
});
