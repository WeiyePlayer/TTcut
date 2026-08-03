import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  dialog: { showSaveDialog: vi.fn() },
}));

import { retainDurationMismatchOutput } from '../src/main/export';

describe('duration mismatch output recovery', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'ttcut-export-recovery-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('moves the completed partial to a collision-safe visible MP4', async () => {
    const partial = path.join(directory, '.output.partial.mp4');
    const output = path.join(directory, 'output.mp4');
    const firstRecovery = path.join(directory, 'output_duration_mismatch.mp4');
    await writeFile(partial, 'completed output');
    await writeFile(firstRecovery, 'older recovery');

    const retained = await retainDurationMismatchOutput(partial, output);

    expect(retained).toEqual({
      path: path.join(directory, 'output_duration_mismatch_2.mp4'),
      renamed: true,
    });
    await expect(access(retained.path)).resolves.toBeUndefined();
    await expect(access(partial)).rejects.toThrow();
  });

  it('keeps the original partial when the visible rename cannot be completed', async () => {
    const partial = path.join(directory, '.output.partial.mp4');
    const output = path.join(directory, 'missing', 'output.mp4');
    await writeFile(partial, 'completed output');

    const retained = await retainDurationMismatchOutput(partial, output);

    expect(retained).toEqual({ path: partial, renamed: false });
    await expect(access(partial)).resolves.toBeUndefined();
  });
});
