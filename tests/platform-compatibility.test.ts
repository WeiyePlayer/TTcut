import { describe, expect, it } from 'vitest';
import { platformCompatibilitySchema } from '../src/shared/contracts';
import { assertPlatformCompatible, getPlatformCompatibility } from '../src/main/platform-compatibility';

describe('Windows platform compatibility', () => {
  it('always reports supported without probing OS version', async () => {
    const result = await getPlatformCompatibility();
    expect(platformCompatibilitySchema.parse(result)).toMatchObject({
      status: 'supported',
      reason: 'supported',
      platform: process.platform,
      architecture: process.arch,
      build_number: null,
      installation_type: 'Unknown',
    });
  });

  it('does not throw from assertPlatformCompatible', async () => {
    await expect(assertPlatformCompatible()).resolves.toBeUndefined();
  });
});
