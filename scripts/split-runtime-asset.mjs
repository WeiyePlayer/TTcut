import { createHash } from 'node:crypto';
import { mkdir, open, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [archiveArgument, partSizeArgument = '1000000000'] = process.argv.slice(2);
if (!archiveArgument) throw new Error('Usage: node scripts/split-runtime-asset.mjs <archive.zip> [part-size-bytes]');
const archive = path.resolve(archiveArgument);
const archiveInfo = await stat(archive);
const partSize = Number(partSizeArgument);
if (!archiveInfo.isFile() || !archive.endsWith('.zip')) throw new Error('The source must be a ZIP archive.');
if (!Number.isSafeInteger(partSize) || partSize < 64 * 1024 * 1024 || partSize >= 2 * 1024 * 1024 * 1024) {
  throw new Error('Part size must be at least 64 MiB and below 2 GiB.');
}

const outputDirectory = path.join(root, '.baseline', 'runtime-assets', 'hosted');
await mkdir(outputDirectory, { recursive: true });
const input = await open(archive, 'r');
const parts = [];
const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
let position = 0;
let index = 1;
try {
  while (position < archiveInfo.size) {
    const filename = `${path.basename(archive)}.part${String(index).padStart(3, '0')}`;
    const destination = path.join(outputDirectory, filename);
    const output = await open(destination, 'w');
    const hash = createHash('sha256');
    const expected = Math.min(partSize, archiveInfo.size - position);
    let written = 0;
    try {
      while (written < expected) {
        const length = Math.min(buffer.length, expected - written);
        const { bytesRead } = await input.read(buffer, 0, length, position);
        if (bytesRead <= 0) throw new Error('Unexpected end of source archive.');
        const chunk = buffer.subarray(0, bytesRead);
        let chunkOffset = 0;
        while (chunkOffset < chunk.length) {
          const { bytesWritten } = await output.write(chunk, chunkOffset, chunk.length - chunkOffset);
          if (bytesWritten <= 0) throw new Error('Unable to write runtime asset part.');
          chunkOffset += bytesWritten;
        }
        hash.update(chunk);
        written += bytesRead;
        position += bytesRead;
      }
    } finally {
      await output.close();
    }
    parts.push({ asset: filename, size_bytes: written, sha256: hash.digest('hex') });
    console.log(`${filename}: ${written}`);
    index += 1;
  }
} finally {
  await input.close();
}

const descriptor = {
  source_asset: path.basename(archive),
  source_size_bytes: archiveInfo.size,
  part_size_bytes: partSize,
  parts,
};
const descriptorPath = path.join(outputDirectory, `${path.basename(archive)}.parts.json`);
await writeFile(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ descriptor: descriptorPath, ...descriptor }, null, 2));
