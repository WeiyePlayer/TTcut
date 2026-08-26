import { cp, lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'resources');
const destination = path.join(root, '.runtime', 'online-installer', 'resources');

async function shouldCopy(sourcePath) {
  const info = await lstat(sourcePath);
  return info.isDirectory() || path.extname(sourcePath).toLowerCase() !== '.pt';
}

await rm(destination, { recursive: true, force: true });
await mkdir(path.dirname(destination), { recursive: true });
await cp(source, destination, { recursive: true, filter: shouldCopy });
await mkdir(path.join(destination, 'models'), { recursive: true });
await writeFile(
  path.join(destination, '.ttcut-online-model-delivery'),
  'TTcut online model installer\n',
  'utf8',
);

console.log(`Staged model-free online installer resources: ${destination}`);
