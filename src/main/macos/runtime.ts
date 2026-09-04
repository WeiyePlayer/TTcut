import path from 'node:path';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { app } from 'electron';
import type { ComponentStatus } from '../../shared/contracts';

export function macRuntimeRoot(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'runtime') : path.join(app.getAppPath(), '.runtime', 'macos');
}
let verified: Promise<void> | undefined;
const manifestSchema = z.object({
  schema_version: z.literal(1), architecture: z.literal('arm64'), minimum_os: z.literal('15.0'),
  files: z.array(z.object({ path: z.string().min(1), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1),
}).strict();
export function verifyMacRuntime(): Promise<void> {
  verified ??= (async () => {
    const root = macRuntimeRoot();
    for (const name of ['TTcutWorker', 'TTcutMediaWorker', 'ffmpeg', 'ffprobe']) await access(path.join(root, 'bin', name), constants.X_OK);
    const manifest = manifestSchema.parse(JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')));
    const listed = new Set(manifest.files.map((file) => file.path));
    const required = ['bin/TTcutWorker', 'bin/TTcutMediaWorker', 'bin/ffmpeg', 'bin/ffprobe',
      'Models/BlurBall.mlmodelc/weights/weight.bin', 'Models/Table.mlmodelc/weights/weight.bin'];
    if (listed.size !== manifest.files.length || required.some((file) => !listed.has(file))) throw new Error('BUNDLED_RUNTIME_MANIFEST_INVALID');
    for (const file of manifest.files) {
      const full = path.resolve(root, file.path);
      if (!full.startsWith(`${root}${path.sep}`)) throw new Error('BUNDLED_RUNTIME_MANIFEST_INVALID');
      const bytes = await readFile(full);
      if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error(`BUNDLED_RESOURCE_CORRUPT: ${file.path}`);
    }
  })().catch((error) => { verified = undefined; throw Object.assign(error, { code: 'BUNDLED_COMPONENT_MISSING' }); });
  return verified;
}
export async function inspectMacComponents(): Promise<ComponentStatus> {
  const error = await verifyMacRuntime().then(() => null, (error: Error) => error.message);
  return {
    analysis: { available: !error, version: 'Core ML · BlurBall + Table', path: macRuntimeRoot(), acceleration: error ? 'unavailable' : 'coreml', detail: error },
    media: { available: !error, version: 'FFmpeg · x264 / x265', path: macRuntimeRoot(), active_encoder: error ? 'unavailable' : 'libx264', x264_available: !error, detail: error },
  };
}
export async function macMediaComponents() {
  await verifyMacRuntime();
  return { ffmpeg: path.join(macRuntimeRoot(), 'bin', 'ffmpeg'), ffprobe: path.join(macRuntimeRoot(), 'bin', 'ffprobe'), mediaEncoder: 'libx264' as const };
}
