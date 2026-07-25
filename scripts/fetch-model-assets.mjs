import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const modelRoot = path.resolve('resources/models');
const assets = [
  {
    target: path.join(modelRoot, 'analyze.pt'),
    source: process.env.TTCUT_TRACKNET_SOURCE?.trim(),
    sourceVariable: 'TTCUT_TRACKNET_SOURCE',
    label: 'TrackNet',
  },
  {
    target: path.join(modelRoot, 'table_analyze.pt'),
    source: process.env.TTCUT_TABLE_ANALYZE_SOURCE?.trim(),
    sourceVariable: 'TTCUT_TABLE_ANALYZE_SOURCE',
    label: 'table analysis',
  },
];

async function fileExists(filePath) {
  return stat(filePath).then((value) => value.isFile() && value.size > 0).catch(() => false);
}

await mkdir(modelRoot, { recursive: true });
for (const asset of assets) {
  if (!await fileExists(asset.target)) {
    if (!asset.source || !await fileExists(asset.source)) {
      throw new Error(`Set ${asset.sourceVariable} to an existing ${asset.label} checkpoint for build-time staging.`);
    }
    await copyFile(asset.source, asset.target);
  }
  const content = await readFile(asset.target);
  console.log(`${path.basename(asset.target)} ${content.length} ${createHash('sha256').update(content).digest('hex')}`);
}
