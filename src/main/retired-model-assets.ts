import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';

export async function purgeRemovedModelAssets(componentRoot: string): Promise<void> {
  const root = path.resolve(componentRoot);
  await rm(path.join(root, 'dual-ball-models'), { recursive: true, force: true });
  for (const [directory, prefix] of [
    ['.downloads', 'ttcut-ball-'],
    ['.manifests', 'dual-ball-models-'],
  ] as const) {
    const targetDirectory = path.join(root, directory);
    const entries = await readdir(targetDirectory, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.startsWith(prefix))
      .map((entry) => rm(path.join(targetDirectory, entry.name), { force: true })));
  }
}
