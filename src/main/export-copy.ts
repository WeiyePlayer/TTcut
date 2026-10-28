import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

/** Copy a verified CFR cache without leaving a blocked copy behind after cancellation. */
export async function copyExportCfr(source: string, destination: string, signal?: AbortSignal): Promise<void> {
  await pipeline(createReadStream(source), createWriteStream(destination, { flags: 'wx' }), signal ? { signal } : {});
}
