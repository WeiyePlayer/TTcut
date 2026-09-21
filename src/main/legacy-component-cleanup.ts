import { rm } from 'node:fs/promises';
import path from 'node:path';

const LEGACY_COMPONENT_ENTRIES = [
  'analysis-runtime',
  'python-3.12.13',
  'ffmpeg-8.1',
  'ffmpeg-x264-N-125716-g1b1f602699',
  'downloads',
  'staging',
  'rollback',
  'active-analysis-runtime.json',
  'component-status.json',
] as const;

export async function cleanupLegacyComponents(root: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  for (const entry of LEGACY_COMPONENT_ENTRIES) {
    const target = path.resolve(resolvedRoot, entry);
    if (path.dirname(target) !== resolvedRoot) throw new Error(`Unsafe legacy component target: ${target}`);
    await rm(target, { recursive: true, force: true });
  }
}
