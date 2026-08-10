import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { purgeRemovedModelAssets } from '../src/main/retired-model-assets';

const temporaryDirectories: string[] = [];

async function exists(filePath: string): Promise<boolean> {
  return access(filePath).then(() => true, () => false);
}

describe('removed model asset cleanup', () => {
  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('removes the retired model directory, downloads, and manifests only', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ttcut-retired-model-'));
    temporaryDirectories.push(root);
    const retiredDirectory = path.join(root, 'dual-ball-models', '1.0.0');
    const downloads = path.join(root, '.downloads');
    const manifests = path.join(root, '.manifests');
    await Promise.all([retiredDirectory, downloads, manifests].map((directory) => mkdir(directory, { recursive: true })));
    await writeFile(path.join(retiredDirectory, 'main.pt'), 'removed');
    await writeFile(path.join(downloads, 'ttcut-ball-main-model.pt.download'), 'removed');
    await writeFile(path.join(manifests, 'dual-ball-models-1.0.0.json'), 'removed');
    await writeFile(path.join(downloads, 'ttcut-analysis-runtime.zip.download'), 'keep');

    await purgeRemovedModelAssets(root);

    expect(await exists(path.join(root, 'dual-ball-models'))).toBe(false);
    expect(await exists(path.join(downloads, 'ttcut-ball-main-model.pt.download'))).toBe(false);
    expect(await exists(path.join(manifests, 'dual-ball-models-1.0.0.json'))).toBe(false);
    expect(await exists(path.join(downloads, 'ttcut-analysis-runtime.zip.download'))).toBe(true);
  });
});
