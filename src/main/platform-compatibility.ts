import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PlatformCompatibility } from '../shared/contracts';

const execFileAsync = promisify(execFile);
const WINDOWS_VERSION_KEY = 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion';

export type PlatformProbe = {
  platform: string;
  architecture: string;
  buildNumber: number | null;
  installationType: 'Client' | 'Server' | 'Unknown';
  probeFailed?: boolean;
};

function unsupported(probe: PlatformProbe, reason: Exclude<PlatformCompatibility['reason'], 'supported'>): PlatformCompatibility {
  return {
    status: 'unsupported',
    reason,
    platform: probe.platform,
    architecture: probe.architecture,
    build_number: probe.buildNumber,
    installation_type: probe.installationType,
  };
}

export function evaluatePlatformCompatibility(probe: PlatformProbe): PlatformCompatibility {
  if (probe.platform !== 'win32') return unsupported(probe, 'unsupported_platform');
  if (probe.architecture !== 'x64') return unsupported(probe, 'unsupported_architecture');
  if (probe.probeFailed || probe.buildNumber === null || probe.installationType === 'Unknown') {
    return unsupported(probe, 'probe_failed');
  }
  if (probe.installationType !== 'Client') return unsupported(probe, 'windows_server');
  if (probe.buildNumber !== 19045 && probe.buildNumber < 22000) {
    return unsupported(probe, 'unsupported_windows_build');
  }
  return {
    status: 'supported',
    reason: 'supported',
    platform: probe.platform,
    architecture: probe.architecture,
    build_number: probe.buildNumber,
    installation_type: probe.installationType,
  };
}

function parseRegistryValue(output: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = output.match(new RegExp(`${escaped}\\s+REG_\\w+\\s+([^\\r\\n]+)`, 'i'));
  return match?.[1]?.trim() || null;
}

async function queryRegistryValue(name: string): Promise<string> {
  const { stdout } = await execFileAsync('reg.exe', ['query', WINDOWS_VERSION_KEY, '/v', name], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const value = parseRegistryValue(stdout, name);
  if (!value) throw new Error(`Windows registry value ${name} was unavailable.`);
  return value;
}

export async function probePlatformCompatibility(): Promise<PlatformCompatibility> {
  const base = { platform: process.platform, architecture: process.arch };
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    return evaluatePlatformCompatibility({ ...base, buildNumber: null, installationType: 'Unknown' });
  }
  try {
    const [rawBuild, rawInstallationType] = await Promise.all([
      queryRegistryValue('CurrentBuildNumber'),
      queryRegistryValue('InstallationType'),
    ]);
    const buildNumber = Number.parseInt(rawBuild, 10);
    if (!Number.isSafeInteger(buildNumber)) throw new Error('CurrentBuildNumber was not an integer.');
    const installationType = rawInstallationType === 'Client'
      ? 'Client'
      : rawInstallationType.startsWith('Server') ? 'Server' : 'Unknown';
    return evaluatePlatformCompatibility({ ...base, buildNumber, installationType });
  } catch {
    return evaluatePlatformCompatibility({
      ...base,
      buildNumber: null,
      installationType: 'Unknown',
      probeFailed: true,
    });
  }
}

let cachedCompatibility: Promise<PlatformCompatibility> | null = null;

export function getPlatformCompatibility(): Promise<PlatformCompatibility> {
  cachedCompatibility ??= probePlatformCompatibility();
  return cachedCompatibility;
}

export async function assertPlatformCompatible(): Promise<void> {
  const compatibility = await getPlatformCompatibility();
  if (compatibility.status === 'supported') return;
  throw new Error(compatibility.reason === 'probe_failed' ? 'PLATFORM_PROBE_FAILED' : 'PLATFORM_UNSUPPORTED');
}

