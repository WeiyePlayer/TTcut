import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const sourceRoot = path.join(root, 'resources');
const destination = path.join(root, '.runtime', 'resources');
const manifest = JSON.parse(await readFile(path.join(sourceRoot, 'model-manifest.json'), 'utf8'));

if (manifest.schema_version !== 2 || manifest.models?.length !== 2) {
  throw new Error('ONNX model manifest schema is invalid.');
}
await rm(destination, { recursive: true, force: true });
await mkdir(path.join(destination, 'models'), { recursive: true });
for (const model of manifest.models) {
  if (!model.filename.endsWith('.onnx')) throw new Error(`Non-ONNX model rejected: ${model.filename}`);
  const source = path.join(sourceRoot, 'models', model.filename);
  const value = await readFile(source);
  const digest = createHash('sha256').update(value).digest('hex');
  const metadata = await stat(source);
  if (metadata.size !== model.size_bytes || digest !== model.sha256) {
    throw new Error(`ONNX model integrity mismatch: ${model.filename}`);
  }
  await cp(source, path.join(destination, 'models', model.filename));
}
await writeFile(
  path.join(destination, 'model-manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8',
);
console.log(`Staged ${manifest.models.length} ONNX models without PyTorch checkpoints.`);
