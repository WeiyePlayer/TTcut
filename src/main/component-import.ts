import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { PendingComponentImport } from '../shared/api';
import type { ComponentCatalog } from './component-catalog';
import { sha256File } from './component-assets';
import type { AnalysisRuntimeVariant } from './runtime-layout';

export type ImportableComponentFile =
  | { kind: 'weight'; sourcePath: string; asset: ComponentCatalog['tracknet_weight'] }
  | {
    kind: 'runtime-part';
    sourcePath: string;
    variant: AnalysisRuntimeVariant;
    asset: ComponentCatalog['analysis_runtime']['assets'][number];
    part: ComponentCatalog['analysis_runtime']['assets'][number]['parts'][number];
  }
  | { kind: 'media'; sourcePath: string; asset: ComponentCatalog['ffmpeg'] };

type ImportCandidate =
  | { kind: 'weight'; asset: ComponentCatalog['tracknet_weight'] }
  | {
    kind: 'runtime-part';
    variant: AnalysisRuntimeVariant;
    asset: ComponentCatalog['analysis_runtime']['assets'][number];
    part: ComponentCatalog['analysis_runtime']['assets'][number]['parts'][number];
  }
  | { kind: 'media'; asset: ComponentCatalog['ffmpeg'] };

export async function validateImportFiles(
  filePaths: string[],
  catalog: ComponentCatalog,
  onProgress?: (completed: number, total: number) => void,
): Promise<ImportableComponentFile[]> {
  if (filePaths.length === 0) throw new Error('COMPONENT_IMPORT_NO_FILES');

  const candidates = new Map<string, ImportCandidate>();
  candidates.set(catalog.tracknet_weight.filename, { kind: 'weight', asset: catalog.tracknet_weight });
  for (const asset of catalog.analysis_runtime.assets) {
    for (const part of asset.parts) {
      candidates.set(part.asset, { kind: 'runtime-part', variant: asset.variant, asset, part });
    }
  }
  candidates.set(catalog.ffmpeg.asset, { kind: 'media', asset: catalog.ffmpeg });

  const selectedNames = new Set<string>();
  const validated: ImportableComponentFile[] = [];
  for (let index = 0; index < filePaths.length; index += 1) {
    const sourcePath = path.resolve(filePaths[index]!);
    const filename = path.basename(sourcePath);
    const candidate = candidates.get(filename);
    if (!candidate) throw new Error(`COMPONENT_IMPORT_UNSUPPORTED_FILE:${filename}`);
    if (selectedNames.has(filename)) throw new Error(`COMPONENT_IMPORT_DUPLICATE_FILE:${filename}`);
    selectedNames.add(filename);

    const metadata = await stat(sourcePath).catch(() => null);
    if (!metadata?.isFile()) throw new Error(`COMPONENT_IMPORT_FILE_NOT_FOUND:${filename}`);
    const expectedSize = candidate.kind === 'runtime-part'
      ? candidate.part.size_bytes
      : candidate.asset.size_bytes;
    if (metadata.size !== expectedSize) throw new Error(`COMPONENT_IMPORT_FILE_SIZE_MISMATCH:${filename}`);
    const expectedHash = candidate.kind === 'runtime-part'
      ? candidate.part.sha256
      : candidate.asset.sha256;
    if (await sha256File(sourcePath) !== expectedHash) throw new Error(`COMPONENT_IMPORT_FILE_HASH_MISMATCH:${filename}`);
    validated.push({ ...candidate, sourcePath } as ImportableComponentFile);
    onProgress?.(index + 1, filePaths.length);
  }

  return validated;
}

export type CachedRuntimeImport = {
  variant: AnalysisRuntimeVariant;
  files: Extract<ImportableComponentFile, { kind: 'runtime-part' }>[];
  pending: PendingComponentImport | null;
};

async function cacheRuntimePart(
  file: Extract<ImportableComponentFile, { kind: 'runtime-part' }>,
  downloadRoot: string,
  taskId: string,
): Promise<void> {
  const target = path.join(downloadRoot, `${file.part.asset}.download`);
  const temporary = path.join(downloadRoot, `${file.part.asset}.${taskId}.importing`);
  await mkdir(downloadRoot, { recursive: true });
  await rm(temporary, { force: true });
  try {
    await copyFile(file.sourcePath, temporary);
    const metadata = await stat(temporary);
    if (metadata.size !== file.part.size_bytes || await sha256File(temporary) !== file.part.sha256) {
      throw new Error(`COMPONENT_IMPORT_CACHE_WRITE_FAILED:${file.part.asset}`);
    }
    await rm(target, { force: true });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function validCachedPart(
  filePath: string,
  part: ComponentCatalog['analysis_runtime']['assets'][number]['parts'][number],
): Promise<boolean> {
  const metadata = await stat(filePath).catch(() => null);
  if (!metadata?.isFile() || metadata.size !== part.size_bytes) return false;
  if (await sha256File(filePath) === part.sha256) return true;
  await rm(filePath, { force: true });
  return false;
}

export async function cacheAndCollectRuntimeImports(
  files: ImportableComponentFile[],
  catalog: ComponentCatalog,
  downloadRoot: string,
  taskId: string,
): Promise<CachedRuntimeImport[]> {
  const selected = files.filter((file): file is Extract<ImportableComponentFile, { kind: 'runtime-part' }> => (
    file.kind === 'runtime-part'
  ));
  for (const file of selected) await cacheRuntimePart(file, downloadRoot, taskId);

  const touchedVariants = new Set(selected.map((file) => file.variant));
  const groups: CachedRuntimeImport[] = [];
  for (const asset of catalog.analysis_runtime.assets) {
    if (!touchedVariants.has(asset.variant)) continue;
    const cachedFiles: Extract<ImportableComponentFile, { kind: 'runtime-part' }>[] = [];
    const missingAssets: string[] = [];
    for (const part of asset.parts) {
      const sourcePath = path.join(downloadRoot, `${part.asset}.download`);
      if (await validCachedPart(sourcePath, part)) {
        cachedFiles.push({ kind: 'runtime-part', sourcePath, variant: asset.variant, asset, part });
      } else {
        missingAssets.push(part.asset);
      }
    }
    groups.push({
      variant: asset.variant,
      files: cachedFiles,
      pending: missingAssets.length === 0 ? null : {
        variant: asset.variant,
        receivedParts: cachedFiles.length,
        totalParts: asset.parts.length,
        missingAssets,
      },
    });
  }
  return groups;
}
