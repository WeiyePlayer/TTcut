import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { ComponentCatalog } from './component-catalog';
import { sha256File } from './component-assets';

export type ImportableComponentFile =
  | { kind: 'weight'; sourcePath: string; asset: ComponentCatalog['tracknet_weight'] }
  | {
    kind: 'runtime-part';
    sourcePath: string;
    variant: 'cpu' | 'cu126';
    asset: ComponentCatalog['analysis_runtime']['assets'][number];
    part: ComponentCatalog['analysis_runtime']['assets'][number]['parts'][number];
  }
  | { kind: 'media'; sourcePath: string; asset: ComponentCatalog['ffmpeg'] };

type ImportCandidate =
  | { kind: 'weight'; asset: ComponentCatalog['tracknet_weight'] }
  | {
    kind: 'runtime-part';
    variant: 'cpu' | 'cu126';
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

  for (const asset of catalog.analysis_runtime.assets) {
    const selectedParts = validated.filter((item): item is Extract<ImportableComponentFile, { kind: 'runtime-part' }> => (
      item.kind === 'runtime-part' && item.variant === asset.variant
    ));
    if (selectedParts.length === 0) continue;
    const missing = asset.parts.filter((part) => !selectedParts.some((item) => item.part.asset === part.asset));
    if (missing.length > 0) throw new Error(`COMPONENT_IMPORT_MISSING_PARTS:${missing.map((part) => part.asset).join(',')}`);
  }

  return validated;
}
