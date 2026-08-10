import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(root, 'resources', 'model-manifest.json'), 'utf8'));

if (manifest.schema_version !== 1 || !Array.isArray(manifest.models) || manifest.models.length !== 3) {
  throw new Error('Model manifest must contain exactly three schema-v1 model entries.');
}

const expectedNames = new Set(['analyze.pt', 'table_analyze.pt', 'blurball_best.pt']);
for (const model of manifest.models) {
  if (!expectedNames.delete(model.filename)) throw new Error(`Unexpected or duplicate model asset: ${model.filename}`);
  if (!Number.isSafeInteger(model.size_bytes) || model.size_bytes <= 0 || !/^[a-f0-9]{64}$/.test(model.sha256)) {
    throw new Error(`Invalid model manifest entry: ${model.filename}`);
  }
  const modelPath = path.join(root, 'resources', 'models', model.filename);
  const metadata = await stat(modelPath).catch(() => null);
  if (!metadata?.isFile()) throw new Error(`Required bundled model is missing: ${modelPath}`);
  if (metadata.size !== model.size_bytes) {
    throw new Error(`Bundled model size mismatch for ${model.filename}: ${metadata.size} !== ${model.size_bytes}`);
  }
  const actualHash = createHash('sha256').update(await readFile(modelPath)).digest('hex');
  if (actualHash !== model.sha256) throw new Error(`Bundled model SHA-256 mismatch for ${model.filename}.`);
  console.log(`Verified bundled model ${model.filename}: ${metadata.size} bytes, sha256=${actualHash}`);
}

if (expectedNames.size) throw new Error(`Missing model manifest entries: ${[...expectedNames].join(', ')}`);
