import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export async function assembleAssetParts(parts: string[], destination: string, expectedSize: number): Promise<void> {
  if (parts.length === 0 || !Number.isSafeInteger(expectedSize) || expectedSize <= 0) {
    throw new Error('COMPONENT_ASSET_PARTS_INVALID');
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await rm(destination, { force: true });
  try {
    for (const [index, part] of parts.entries()) {
      await pipeline(createReadStream(part), createWriteStream(destination, { flags: index === 0 ? 'w' : 'a' }));
    }
    if ((await stat(destination)).size !== expectedSize) throw new Error('COMPONENT_ASSET_ASSEMBLY_SIZE_MISMATCH');
  } catch (error) {
    await rm(destination, { force: true });
    throw error;
  }
}
