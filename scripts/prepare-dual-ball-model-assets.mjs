import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.resolve(process.argv[2] ?? 'D:/DOCUMENTS/UpliftingTableTennis/UpliftingTableTennis#/weights/inference_balldetection');
const outputRoot = path.resolve(process.argv[3] ?? path.join(root, '.baseline', 'runtime-assets', 'dual-ball-models-1.0.0'));
const catalog = JSON.parse(await readFile(path.join(root, 'resources', 'components.json'), 'utf8'));
const component = catalog.dual_ball_models;

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

await mkdir(outputRoot, { recursive: true });
for (const asset of component.assets) {
  const source = path.join(sourceRoot, asset.role === 'main' ? 'segformerpp_b2' : 'wasb', 'model.pt');
  const metadata = await stat(source);
  const digest = await sha256(source);
  if (metadata.size !== asset.size_bytes || digest !== asset.sha256) {
    throw new Error(`Source ${asset.role} checkpoint does not match the pinned catalog.`);
  }
  await copyFile(source, path.join(outputRoot, asset.asset));
}

const manifest = {
  schema_version: 1,
  repository: 'WeiyePlayer/TTcut-runtime-assets',
  tag: component.release_tag,
  component_version: component.version,
  assets: component.assets.map(({ role, asset, size_bytes, sha256 }) => ({ role, asset, size_bytes, sha256 })),
};
await writeFile(path.join(outputRoot, 'dual-ball-models-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(outputRoot);
