import type { ForgeConfig } from '@electron-forge/shared-types';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import type { SignToolOptions } from '@electron/windows-sign';
import type { SignToolOptions as EsmSignToolOptions } from '@electron/windows-sign/dist/esm/types';
import packageJson from './package.json';

const publicReleaseCandidate = process.env.TTCUT_PUBLIC_RC === '1';
function ignoreUnbuiltSource(file: string): boolean {
  if (!file) return false;
  return !file.startsWith('/.vite');
}
const publisherName = process.env.TTCUT_PUBLISHER_NAME?.trim() || 'weiye';
const certificateFile = process.env.WINDOWS_CERTIFICATE_FILE?.trim();
const certificatePassword = process.env.WINDOWS_CERTIFICATE_PASSWORD;
const customSigning = Boolean(process.env.WINDOWS_SIGN_WITH_PARAMS || process.env.WINDOWS_SIGNTOOL_PATH);
const signingConfigured = Boolean((certificateFile && certificatePassword) || customSigning);
const timestampServer = process.env.WINDOWS_TIMESTAMP_SERVER?.trim() || 'http://timestamp.digicert.com';

if (publicReleaseCandidate && !signingConfigured) {
  throw new Error('A public release candidate requires Authenticode credentials or a configured hardware/cloud signing command.');
}
if (publicReleaseCandidate && certificateFile && !existsSync(certificateFile)) {
  throw new Error('WINDOWS_CERTIFICATE_FILE does not exist.');
}
if (!/^https?:\/\//i.test(timestampServer)) throw new Error('WINDOWS_TIMESTAMP_SERVER must be an HTTP(S) RFC 3161 endpoint.');

const signingBase = {
  ...(certificateFile ? { certificateFile } : {}),
  ...(certificatePassword ? { certificatePassword } : {}),
  timestampServer,
  description: 'TTcut',
  ...(process.env.TTCUT_PUBLISHER_WEBSITE ? { website: process.env.TTCUT_PUBLISHER_WEBSITE } : {}),
};
const packagerWindowsSign = signingConfigured ? {
  ...signingBase,
  hashes: ['sha256'] as NonNullable<EsmSignToolOptions['hashes']>,
} : undefined;
const squirrelWindowsSign = signingConfigured ? {
  ...signingBase,
  hashes: ['sha256'] as NonNullable<SignToolOptions['hashes']>,
} : undefined;

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    executableName: 'TTcut',
    ignore: ignoreUnbuiltSource,
    extraResource: ['.runtime/worker', '.runtime/release-metadata', 'resources'],
    win32metadata: {
      CompanyName: publisherName,
      FileDescription: 'TTcut local table-tennis rally cutter',
      InternalName: 'TTcut',
      OriginalFilename: 'TTcut.exe',
      ProductName: 'TTcut',
    },
    ...(packagerWindowsSign ? { windowsSign: packagerWindowsSign } : {}),
    download: {
      cacheRoot: path.resolve('.electron-cache'),
    },
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({
      name: 'TTcut',
      authors: publisherName,
      owners: publisherName,
      copyright: `Copyright © 2026 ${publisherName}`,
      setupExe: `TTcut-${packageJson.version}-x64-Setup.exe`,
      noMsi: true,
      ...(squirrelWindowsSign ? { windowsSign: squirrelWindowsSign } : {}),
    }),
  ],
  plugins: [
    new VitePlugin({
      build: [
        { entry: 'src/main/index.ts', config: 'vite.main.config.ts' },
        { entry: 'src/preload/index.ts', config: 'vite.preload.config.ts' },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
