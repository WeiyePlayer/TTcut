import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, copyFile, mkdir, open, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { loadComponentCatalog } from './component-catalog';
import { validateAnalysisRuntime, validateMediaComponent } from './components';

const requestSchema = z.object({
  schema_version: z.literal(1),
  source: z.string().min(1),
  target: z.string().min(1),
  report: z.string().min(1),
}).strict();

export type InstallerMigrationReport = {
  schema_version: 1;
  status: 'ok' | 'error';
  source: string;
  target: string;
  files: number;
  bytes: number;
  error_code: string | null;
};

type MigrationFile = { source: string; relative: string; size: number };

async function exists(value: string): Promise<boolean> {
  try {
    await access(value);
    return true;
  } catch {
    return false;
  }
}

function assertSafeDirectory(value: string): string {
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) throw new Error('INSTALLER_MIGRATION_BROAD_PATH');
  return resolved;
}

async function listMigrationFiles(root: string, directory = root): Promise<MigrationFile[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: MigrationFile[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error('INSTALLER_MIGRATION_REPARSE_POINT');
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listMigrationFiles(root, absolute));
    else if (entry.isFile()) {
      files.push({
        source: absolute,
        relative: path.relative(root, absolute),
        size: (await stat(absolute)).size,
      });
    }
  }
  return files;
}

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function assertTargetEmpty(target: string): Promise<void> {
  if (!await exists(target)) return;
  if ((await readdir(target)).length > 0) throw new Error('INSTALLER_MIGRATION_TARGET_NOT_EMPTY');
}

async function validateMigratedComponents(target: string): Promise<void> {
  const catalog = await loadComponentCatalog();
  for (const asset of catalog.analysis_runtime.assets) {
    const python = path.join(target, ...asset.install_directory.split('/'), 'python.exe');
    if (await exists(python)) await validateAnalysisRuntime(python);
  }
  for (const [asset, encoder] of [
    [catalog.ffmpeg, 'libopenh264'],
    [catalog.ffmpeg_x264, 'libx264'],
  ] as const) {
    const bin = path.join(target, asset.install_directory, 'bin');
    const ffmpeg = path.join(bin, 'ffmpeg.exe');
    const ffprobe = path.join(bin, 'ffprobe.exe');
    if (await exists(ffmpeg) || await exists(ffprobe)) {
      if (!await exists(ffmpeg) || !await exists(ffprobe)) throw new Error('INSTALLER_MIGRATION_COMPONENT_INCOMPLETE');
      await validateMediaComponent(ffmpeg, ffprobe, encoder);
    }
  }
}

export async function migrateComponents(sourceValue: string, targetValue: string): Promise<InstallerMigrationReport> {
  const source = assertSafeDirectory(sourceValue);
  const target = assertSafeDirectory(targetValue);
  const sourceKey = `${path.normalize(source).toLocaleLowerCase()}${path.sep}`;
  const targetKey = `${path.normalize(target).toLocaleLowerCase()}${path.sep}`;
  if (sourceKey.startsWith(targetKey) || targetKey.startsWith(sourceKey)) throw new Error('INSTALLER_MIGRATION_PATH_OVERLAP');
  const sourceInfo = await stat(source).catch(() => null);
  if (!sourceInfo?.isDirectory()) throw new Error('INSTALLER_MIGRATION_SOURCE_MISSING');
  await assertTargetEmpty(target);
  await mkdir(target, { recursive: true });

  const files = await listMigrationFiles(source);
  let copiedBytes = 0;
  for (const file of files) {
    const destination = path.join(target, file.relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(file.source, destination);
    const targetInfo = await stat(destination);
    if (targetInfo.size !== file.size || await sha256(file.source) !== await sha256(destination)) {
      throw new Error('INSTALLER_MIGRATION_COPY_MISMATCH');
    }
    copiedBytes += file.size;
  }
  await validateMigratedComponents(target);
  return {
    schema_version: 1,
    status: 'ok',
    source,
    target,
    files: files.length,
    bytes: copiedBytes,
    error_code: null,
  };
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /^[A-Z][A-Z0-9_]+$/.test(message) ? message : 'INSTALLER_MIGRATION_FAILED';
}

function decodeRequest(raw: Buffer): string {
  if (raw[0] === 0xff && raw[1] === 0xfe) return raw.subarray(2).toString('utf16le');
  if (raw.length >= 2 && raw[1] === 0x00) return raw.toString('utf16le');
  return raw.toString('utf8');
}

export async function runInstallerMigrationRequest(requestPath: string): Promise<number> {
  let request: z.infer<typeof requestSchema> | null = null;
  try {
    const handle = await open(path.resolve(requestPath), 'r');
    try {
      const raw = await handle.readFile();
      request = requestSchema.parse(JSON.parse(decodeRequest(raw)) as unknown);
    } finally {
      await handle.close();
    }
    const report = await migrateComponents(request.source, request.target);
    await mkdir(path.dirname(path.resolve(request.report)), { recursive: true });
    await writeFile(path.resolve(request.report), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return 0;
  } catch (error) {
    if (request) {
      const report: InstallerMigrationReport = {
        schema_version: 1,
        status: 'error',
        source: path.resolve(request.source),
        target: path.resolve(request.target),
        files: 0,
        bytes: 0,
        error_code: errorCode(error),
      };
      await mkdir(path.dirname(path.resolve(request.report)), { recursive: true }).catch(() => undefined);
      await writeFile(path.resolve(request.report), `${JSON.stringify(report, null, 2)}\n`, 'utf8').catch(() => undefined);
    }
    return 1;
  }
}
