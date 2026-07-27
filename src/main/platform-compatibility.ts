import type { PlatformCompatibility } from '../shared/contracts';

/**
 * Platform version gates were removed.
 * Bootstrap still exposes a fixed "supported" payload so existing UI/API contracts keep working.
 */
export function getPlatformCompatibility(): Promise<PlatformCompatibility> {
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
