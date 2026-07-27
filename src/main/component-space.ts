import { access, mkdir, readdir, stat, statfs } from 'node:fs/promises';
import path from 'node:path';

export const COMPONENT_SPACE_RESERVE_BYTES = 512 * 1024 * 1024;

async function exists(value: string): Promise<boolean> {
  try {
    await access(value);
    return true;
  } catch {
    return false;
  }
}

export async function directorySize(directory: string): Promise<number> {
  if (!await exists(directory)) return 0;
  const entries = await readdir(directory, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directorySize(absolute);
    else if (entry.isFile()) total += (await stat(absolute)).size;
  }
  return total;
}

export async function fileSize(filePath: string): Promise<number> {
  try {
    const value = await stat(filePath);
    return value.isFile() ? value.size : 0;
  } catch {
    return 0;
  }
}

export function remainingDownloadBytes(expectedBytes: number, existingBytes: number): number {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0
    || !Number.isSafeInteger(existingBytes) || existingBytes < 0) {
    throw new Error('COMPONENT_SPACE_INPUT_INVALID');
  }
  return Math.max(0, expectedBytes - Math.min(expectedBytes, existingBytes));
}

export function requiredComponentSpace(
  downloadBytes: number,
  installedBytes: number,
  backupBytes: number,
): number {
  for (const value of [downloadBytes, installedBytes, backupBytes]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('COMPONENT_SPACE_INPUT_INVALID');
  }
  return downloadBytes + installedBytes + backupBytes + COMPONENT_SPACE_RESERVE_BYTES;
}

export async function ensureComponentSpace(
  componentRoot: string,
  downloadBytes: number,
  installedBytes: number,
  backupBytes: number,
): Promise<void> {
  await mkdir(componentRoot, { recursive: true });
  const filesystem = await statfs(componentRoot, { bigint: true });
  const available = filesystem.bavail * filesystem.bsize;
  const required = BigInt(requiredComponentSpace(downloadBytes, installedBytes, backupBytes));
  if (available < required) {
    throw new Error(`COMPONENT_SPACE_INSUFFICIENT:${required}:${available}`);
  }
}
