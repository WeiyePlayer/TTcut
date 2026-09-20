import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupLegacyComponents } from '../src/main/legacy-component-cleanup';

let root = '';
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'ttcut-legacy-cleanup-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('legacy component cleanup', () => {
  it('removes only the exact legacy whitelist and is idempotent', async () => {
    for (const name of ['analysis-runtime', 'ffmpeg-8.1', 'downloads', 'staging', 'rollback']) {
      await mkdir(path.join(root, name), { recursive: true });
      await writeFile(path.join(root, name, 'old.bin'), 'old');
    }
    await writeFile(path.join(root, 'component-status.json'), '{}');
    await mkdir(path.join(root, 'user-preserved'), { recursive: true });
    await writeFile(path.join(root, 'user-preserved', 'keep.txt'), 'keep');

    await cleanupLegacyComponents(root);
    await cleanupLegacyComponents(root);

    await expect(readFile(path.join(root, 'user-preserved', 'keep.txt'), 'utf8')).resolves.toBe('keep');
    await expect(readFile(path.join(root, 'component-status.json'), 'utf8')).rejects.toThrow();
  });
});
