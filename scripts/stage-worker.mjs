import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'worker');
const runtimeRoot = path.join(root, '.runtime');
const destination = path.join(runtimeRoot, 'worker');

if (path.dirname(destination) !== runtimeRoot || path.basename(destination) !== 'worker') {
  throw new Error(`Refusing to stage an unexpected destination: ${destination}`);
}

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(path.join(source, 'ttcut_worker'), path.join(destination, 'ttcut_worker'), {
  recursive: true,
  filter: (entry) => !entry.includes('__pycache__') && !entry.endsWith('.pyc'),
});
for (const name of ['requirements-cpu.txt', 'requirements-cu126.txt', 'requirements-cu132.txt', 'runtime-wheel-lock.json', 'SOURCE_MANIFEST.md', 'LICENSE.tracknet.txt']) {
  await cp(path.join(source, name), path.join(destination, name));
}

console.log(`Staged minimal Worker runtime: ${destination}`);
