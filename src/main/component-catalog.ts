import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import { z } from 'zod';
import type { ComponentSetupInfo } from '../shared/contracts';
import {
  ANALYSIS_PYTHON_VERSION,
  ANALYSIS_RUNTIME_ID,
  ANALYSIS_RUNTIME_VARIANTS,
  ANALYSIS_TORCH_VERSION,
  analysisRuntimeDirectory,
} from './runtime-layout';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const componentCatalogSchema = z.object({
  schema_version: z.literal(1),
  tracknet_weight: z.object({
    filename: z.literal('TrackNet_best.pt'),
    sha256: sha256Schema,
    source: z.string().min(1),
    redistribution: z.enum(['internal-only', 'redistributable']),
    downloadable: z.boolean(),
    provider: z.string().min(1),
    release_tag: z.string().min(1),
    url: z.string().url().refine((value) => value.startsWith('https://')),
    size_bytes: z.number().int().positive(),
    install_directory: z.literal('models'),
    rights_evidence: z.object({
      path: z.string().regex(/^rights\/[^/]+\.(?:md|pdf)$/),
      sha256: sha256Schema,
      rightsholder: z.string().min(1),
      grant: z.string().min(1),
    }).strict().nullable(),
  }).strict().superRefine((weight, context) => {
    if (weight.redistribution === 'internal-only' && (weight.downloadable || weight.rights_evidence !== null)) {
      context.addIssue({ code: 'custom', message: 'Internal-only weights cannot be downloadable or claim rights evidence.' });
    }
    if (weight.redistribution === 'redistributable' && weight.rights_evidence === null) {
      context.addIssue({ code: 'custom', path: ['rights_evidence'], message: 'Redistributable weights require immutable rights evidence.' });
    }
  }),
  analysis_runtime: z.object({
    runtime_id: z.literal(ANALYSIS_RUNTIME_ID),
    python_version: z.literal(ANALYSIS_PYTHON_VERSION),
    torch_version: z.literal(ANALYSIS_TORCH_VERSION),
    license_url: z.string().url().refine((value) => value.startsWith('https://')),
    assets: z.array(z.object({
      variant: z.enum(ANALYSIS_RUNTIME_VARIANTS),
      provider: z.string().min(1),
      asset: z.string().endsWith('.zip'),
      archive_root: z.string().regex(/^[A-Za-z0-9._-]+$/),
      install_directory: z.string().min(1),
      size_bytes: z.number().int().positive(),
      sha256: sha256Schema,
      parts: z.array(z.object({
        asset: z.string().regex(/^[A-Za-z0-9._+-]+$/),
        url: z.string().url().refine((value) => value.startsWith('https://')),
        size_bytes: z.number().int().positive(),
        sha256: sha256Schema,
      }).strict()).min(1).max(8),
    }).strict().superRefine((asset, context) => {
      const names = new Set(asset.parts.map((part) => part.asset));
      if (names.size !== asset.parts.length) context.addIssue({ code: 'custom', path: ['parts'], message: 'Runtime asset part names must be unique.' });
      if (asset.parts.reduce((total, part) => total + part.size_bytes, 0) !== asset.size_bytes) {
        context.addIssue({ code: 'custom', path: ['parts'], message: 'Runtime asset part sizes must equal the complete archive size.' });
      }
    })).max(2),
  }).strict().superRefine((runtime, context) => {
    const variants = new Set<string>();
    for (const [index, asset] of runtime.assets.entries()) {
      if (variants.has(asset.variant)) context.addIssue({ code: 'custom', path: ['assets', index, 'variant'], message: 'Duplicate runtime variant.' });
      variants.add(asset.variant);
      if (asset.install_directory !== analysisRuntimeDirectory(asset.variant)) {
        context.addIssue({ code: 'custom', path: ['assets', index, 'install_directory'], message: 'Runtime install directory does not match its variant.' });
      }
    }
  }),
  ffmpeg: z.object({
    provider: z.string().min(1),
    release_tag: z.string().min(1),
    version_line: z.string().min(1),
    variant: z.literal('win64-lgpl-shared-8.1'),
    asset: z.string().endsWith('.zip'),
    archive_root: z.string().regex(/^[A-Za-z0-9._-]+$/),
    install_directory: z.literal('ffmpeg-8.1'),
    url: z.string().url().refine((value) => value.startsWith('https://')),
    license_url: z.string().url().refine((value) => value.startsWith('https://')),
    size_bytes: z.number().int().positive(),
    sha256: sha256Schema,
    required_build_flags: z.array(z.string().min(1)).min(1),
    required_encoders: z.array(z.string().min(1)).min(1),
  }).strict(),
}).strict();

export type ComponentCatalog = z.infer<typeof componentCatalogSchema>;

function catalogPath(): string {
  return path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'resources', 'components.json');
}

let catalogPromise: Promise<ComponentCatalog> | null = null;

export function loadComponentCatalog(): Promise<ComponentCatalog> {
  catalogPromise ??= readFile(catalogPath(), 'utf8').then((text) => componentCatalogSchema.parse(JSON.parse(text) as unknown));
  return catalogPromise;
}

export async function componentSetupInfo(): Promise<ComponentSetupInfo> {
  const catalog = await loadComponentCatalog();
  return {
    analysis_offer: catalog.analysis_runtime.assets.length === ANALYSIS_RUNTIME_VARIANTS.length ? {
      id: 'analysis',
      version: `${catalog.analysis_runtime.python_version} / ${catalog.analysis_runtime.torch_version}`,
      download_size_bytes: catalog.tracknet_weight.size_bytes
        + catalog.analysis_runtime.assets.reduce((total, asset) => total + asset.size_bytes, 0),
      license_url: catalog.analysis_runtime.license_url,
      available_for_download: process.platform === 'win32',
    } : null,
    media_offer: {
      id: 'media',
      version: catalog.ffmpeg.version_line,
      download_size_bytes: catalog.ffmpeg.size_bytes,
      license_url: catalog.ffmpeg.license_url,
      available_for_download: process.platform === 'win32',
    },
  };
}
