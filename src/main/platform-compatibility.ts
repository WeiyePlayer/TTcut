import { release } from 'node:os';
import type { PlatformCompatibility } from '../shared/contracts';

/**
 * Windows keeps its existing ungated behavior. The Mac target is macOS 15+ arm64.
 */
export function getPlatformCompatibility(): Promise<PlatformCompatibility> {
  if (process.platform === 'darwin') {
    const reason = process.arch !== 'arm64' ? 'unsupported_architecture' : Number(release().split('.')[0]) < 24 ? 'unsupported_macos_version' : 'supported';
    return Promise.resolve({ status: reason === 'supported' ? 'supported' : 'unsupported', reason, platform: process.platform, architecture: process.arch, build_number: null, installation_type: 'Unknown' });
  }
  return Promise.resolve({
    status: 'supported',
    reason: 'supported',
    platform: process.platform,
    architecture: process.arch,
    build_number: null,
    installation_type: 'Unknown',
  });
}

/** @deprecated No-op. Kept for call-site compatibility during cleanup. */
export async function assertPlatformCompatible(): Promise<void> {}
