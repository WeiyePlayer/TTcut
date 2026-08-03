import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetRoot = path.resolve(process.argv[2] ?? path.join(root, '.baseline', 'runtime-assets', 'dual-ball-models-1.0.0'));
const catalog = JSON.parse(await readFile(path.join(root, 'resources', 'components.json'), 'utf8'));

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

for (const asset of catalog.dual_ball_models.assets) {
  const file = path.join(assetRoot, asset.asset);
  const metadata = await stat(file);
  if (metadata.size !== asset.size_bytes || await sha256(file) !== asset.sha256) {
    throw new Error(`Prepared asset failed verification: ${asset.asset}`);
  }
}
const manifest = JSON.parse(await readFile(path.join(assetRoot, 'dual-ball-models-manifest.json'), 'utf8'));
if (manifest.tag !== catalog.dual_ball_models.release_tag || manifest.assets.length !== 2) {
  throw new Error('Prepared dual-model manifest does not match the component catalog.');
}
console.log(`Verified dual ball model assets in ${assetRoot}`);
