import { randomUUID } from 'node:crypto';
import { mkdir, open, rm } from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import { logLine } from './logger';

const UNWRITABLE_CODES = new Set(['EACCES', 'EPERM', 'EROFS']);

/** Returns the error code when `directory` rejects a probe file, or null when it is writable. */
async function writeProbeFailure(directory: string): Promise<string | null> {
  const probe = path.join(directory, `.ttcut-${randomUUID()}.write-test`);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(probe, 'wx');
    return null;
  } catch (error) {
    return String((error as NodeJS.ErrnoException).code ?? 'UNKNOWN');
  } finally {
    await handle?.close().catch(() => undefined);
    if (handle) await rm(probe, { force: true }).catch(() => undefined);
  }
}

/**
 * Chooses where export artifacts for `sourcePath` are written. The source directory is used when
 * writable; when it rejects writes with EACCES/EPERM/EROFS, `<videos>/TTcut` is created and used
 * instead. Any other probe failure (such as a moved source) keeps the source directory so the
 * existing export preconditions report it.
 */
export async function resolveWritableOutputDirectory(sourcePath: string, logTaskId = 'app'): Promise<string> {
  const sourceDirectory = path.dirname(sourcePath);
  const failure = await writeProbeFailure(sourceDirectory);
  if (failure === null || !UNWRITABLE_CODES.has(failure)) return sourceDirectory;

  const fallback = path.join(app.getPath('videos'), 'TTcut');
  try {
    await mkdir(fallback, { recursive: true });
  } catch {
    throw new Error('OUTPUT_DIRECTORY_UNWRITABLE');
  }
  if (await writeProbeFailure(fallback) !== null) throw new Error('OUTPUT_DIRECTORY_UNWRITABLE');
  await logLine(logTaskId, 'INFO', `Export output directory fallback: ${sourceDirectory} -> ${fallback}`)
    .catch(() => undefined);
  return fallback;
}
