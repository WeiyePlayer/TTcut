import { randomUUID } from 'node:crypto';
import { mkdir, open, rm } from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import { logLine } from './logger';

/** Probe failures that mean "write somewhere else" rather than "the source has moved". */
const FALLBACK_CODES = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOSPC']);

/**
 * Creates and removes an exclusive probe file in `directory`. Returns the errno code when the
 * probe is rejected, or null when the directory accepts writes. Only a probe this call created
 * is removed.
 */
export async function writeProbeFailure(
  directory: string,
  name = `.ttcut-${randomUUID()}.write-test`,
): Promise<string | null> {
  const probe = path.join(directory, name);
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

function fallbackDirectory(): string {
  return path.join(app.getPath('videos'), 'TTcut');
}

/**
 * Chooses where export artifacts for `sourcePath` are written. The source directory is used when
 * writable; when it rejects writes with EACCES/EPERM/EROFS/ENOSPC, `<videos>/TTcut` is created and
 * used instead. If that is unusable too, a full volume on either side reports DISK_SPACE_LOW and
 * anything else OUTPUT_DIRECTORY_UNWRITABLE. Other probe failures (such as a moved source) keep
 * the source directory so the existing export preconditions report them.
 */
export async function resolveWritableOutputDirectory(sourcePath: string, logTaskId = 'app'): Promise<string> {
  const sourceDirectory = path.dirname(sourcePath);
  const failure = await writeProbeFailure(sourceDirectory);
  if (failure === null || !FALLBACK_CODES.has(failure)) return sourceDirectory;

  const fallback = fallbackDirectory();
  const fallbackFailure = await mkdir(fallback, { recursive: true }).then(
    () => writeProbeFailure(fallback),
    (error: NodeJS.ErrnoException) => String(error.code ?? 'UNKNOWN'),
  );
  if (fallbackFailure !== null) {
    throw new Error(failure === 'ENOSPC' || fallbackFailure === 'ENOSPC' ? 'DISK_SPACE_LOW' : 'OUTPUT_DIRECTORY_UNWRITABLE');
  }
  await logLine(logTaskId, 'INFO', `Export output directory fallback: ${sourceDirectory} -> ${fallback}`)
    .catch(() => undefined);
  return fallback;
}

/**
 * Default folder for the save dialog. Never throws: the source directory when writable, else the
 * fallback when it exists or can be created, else the source directory. The user picks the final
 * location, which the export preconditions then check.
 */
export async function defaultSaveDialogDirectory(sourcePath: string): Promise<string> {
  const sourceDirectory = path.dirname(sourcePath);
  if (await writeProbeFailure(sourceDirectory) === null) return sourceDirectory;
  const fallback = fallbackDirectory();
  return mkdir(fallback, { recursive: true }).then(() => fallback, () => sourceDirectory);
}
