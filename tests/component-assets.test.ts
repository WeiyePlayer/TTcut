import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assembleAssetParts, sha256File } from '../src/main/component-assets';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const value = await mkdtemp(path.join(tmpdir(), 'ttcut-asset-parts-'));
  temporaryDirectories.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('runtime asset assembly', () => {
  it('concatenates immutable parts in catalog order', async () => {
    const root = await temporaryDirectory();
    const first = path.join(root, 'runtime.part001');
    const second = path.join(root, 'runtime.part002');
    const output = path.join(root, 'runtime.zip');
    await writeFile(first, Buffer.from([0, 1, 2]));
    await writeFile(second, Buffer.from([3, 4]));

    await assembleAssetParts([first, second], output, 5);

    await expect(readFile(output)).resolves.toEqual(Buffer.from([0, 1, 2, 3, 4]));
  });

  it('deletes an assembled file when the complete size is wrong', async () => {
    const root = await temporaryDirectory();
    const part = path.join(root, 'runtime.part001');
    const output = path.join(root, 'runtime.zip');
    await writeFile(part, 'short', 'utf8');

    await expect(assembleAssetParts([part], output, 6)).rejects.toThrow('COMPONENT_ASSET_ASSEMBLY_SIZE_MISMATCH');
    await expect(readFile(output)).rejects.toThrow();
  });

  it('computes a stable SHA-256 for downloaded assets', async () => {
    const root = await temporaryDirectory();
    const asset = path.join(root, 'asset.bin');
    await writeFile(asset, 'ttcut', 'utf8');
    await expect(sha256File(asset)).resolves.toBe('931d8abffa9c0256cc5fd774f084318db9ca2500c2e05a6359fc4928f62b36b5');
  });
});
