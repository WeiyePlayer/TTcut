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
  filter: (entry) => {
    const name = path.basename(entry);
    return !entry.includes('__pycache__')
      && !entry.endsWith('.pyc')
      && !['blurball_model.py', 'blurball_models.py', 'table_model.py', 'device.py'].includes(name)
      && !/^tracknet_.*\.py$/i.test(name);
  },
});
for (const name of ['requirements-onnx.txt', 'SOURCE_MANIFEST.md']) {
  await cp(path.join(source, name), path.join(destination, name));
}

console.log(`Staged minimal Worker runtime: ${destination}`);
