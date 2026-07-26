import { describe, expect, it } from 'vitest';
import { platformCompatibilitySchema } from '../src/shared/contracts';
import { evaluatePlatformCompatibility, type PlatformProbe } from '../src/main/platform-compatibility';

const supportedBase: PlatformProbe = {
  platform: 'win32',
  architecture: 'x64',
  buildNumber: 19045,
  installationType: 'Client',
};

describe('Windows platform compatibility', () => {
  it.each([19045, 22000, 22621, 26100, 30000])('accepts supported client build %i', (buildNumber) => {
    const result = evaluatePlatformCompatibility({ ...supportedBase, buildNumber });
    expect(platformCompatibilitySchema.parse(result)).toMatchObject({
      status: 'supported',
      reason: 'supported',
      build_number: buildNumber,
    });
  });

  it.each([17763, 19044, 20348, 21999])('rejects unsupported client build %i', (buildNumber) => {
    expect(evaluatePlatformCompatibility({ ...supportedBase, buildNumber })).toMatchObject({
      status: 'unsupported',
      reason: 'unsupported_windows_build',
    });
  });

  it('rejects Windows Server even when its build overlaps Windows 11', () => {
    expect(evaluatePlatformCompatibility({ ...supportedBase, buildNumber: 26100, installationType: 'Server' })).toMatchObject({
      status: 'unsupported',
      reason: 'windows_server',
    });
  });

  it.each([
    [{ ...supportedBase, platform: 'darwin' }, 'unsupported_platform'],
    [{ ...supportedBase, architecture: 'arm64' }, 'unsupported_architecture'],
    [{ ...supportedBase, architecture: 'ia32' }, 'unsupported_architecture'],
    [{ ...supportedBase, buildNumber: null, installationType: 'Unknown', probeFailed: true }, 'probe_failed'],
  ] as const)('fails closed for an unsupported or unreadable probe', (probe, reason) => {
    expect(evaluatePlatformCompatibility(probe)).toMatchObject({ status: 'unsupported', reason });
  });
});

