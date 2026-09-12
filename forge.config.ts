import type { ForgeConfig } from '@electron-forge/shared-types';
import { existsSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import type { SignToolOptions as EsmSignToolOptions } from '@electron/windows-sign/dist/esm/types';

const macBuild = process.platform === 'darwin';
const publicReleaseCandidate = process.env.TTCUT_PUBLIC_RC === '1';
const officialRelease = process.env.TTCUT_OFFICIAL_RELEASE === '1';
const releaseSigningRequired = !macBuild && (publicReleaseCandidate || officialRelease);
const onlineModelInstaller = process.env.TTCUT_ONLINE_MODEL_INSTALLER === '1';
const retainedWindowsLocales = new Set(['en-US.pak', 'zh-CN.pak']);

function ignoreUnbuiltSource(file: string): boolean {
  if (!file) return false;
  return !file.startsWith('/.vite');
}

function retainSupportedWindowsLocales(
  buildPath: string,
  _electronVersion: string,
  platform: string,
  _arch: string,
  callback: (error?: Error | null) => void,
): void {
  if (platform !== 'win32') {
    callback();
    return;
  }
  const localesDirectory = path.join(buildPath, 'locales');
  readdir(localesDirectory, { withFileTypes: true })
    .then((entries) => Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.pak') && !retainedWindowsLocales.has(entry.name))
      .map((entry) => rm(path.join(localesDirectory, entry.name))))
    )
    .then(() => callback())
    .catch((error: unknown) => callback(error instanceof Error ? error : new Error(String(error))));
}

const publisherName = process.env.TTCUT_PUBLISHER_NAME?.trim() || 'weiye';
const certificateFile = process.env.WINDOWS_CERTIFICATE_FILE?.trim();
const certificatePassword = process.env.WINDOWS_CERTIFICATE_PASSWORD;
const certificateThumbprint = process.env.WINDOWS_CERTIFICATE_THUMBPRINT?.replace(/\s+/g, '').toUpperCase();
const signToolPath = process.env.WINDOWS_SIGNTOOL_PATH?.trim();
const customSigningParams = process.env.WINDOWS_SIGN_WITH_PARAMS?.trim();
const customSigning = Boolean(customSigningParams || signToolPath || certificateThumbprint);
const signingConfigured = Boolean((certificateFile && certificatePassword) || customSigning);
const timestampServer = process.env.WINDOWS_TIMESTAMP_SERVER?.trim() || 'http://timestamp.digicert.com';
const electronWin32X64Checksums = process.platform === 'win32' && process.arch === 'x64'
  ? { 'electron-v43.1.1-win32-x64.zip': 'b4e9995cd3f65785eb8818276aa9020f3165ab11da41b3c762616d4a0ad8c7ad' }
  : undefined;

if (releaseSigningRequired && !signingConfigured) {
  throw new Error('A public release requires Authenticode credentials or a configured signing command.');
}
if (releaseSigningRequired && certificateFile && !existsSync(certificateFile)) {
  throw new Error('WINDOWS_CERTIFICATE_FILE does not exist.');
}
if (officialRelease && !certificateThumbprint) throw new Error('TTCUT_OFFICIAL_RELEASE requires WINDOWS_CERTIFICATE_THUMBPRINT.');
if (officialRelease && (!signToolPath || !existsSync(signToolPath))) throw new Error('TTCUT_OFFICIAL_RELEASE requires an existing Windows SDK SignTool path.');
if (certificateThumbprint && !/^[A-F0-9]{40,64}$/.test(certificateThumbprint)) throw new Error('WINDOWS_CERTIFICATE_THUMBPRINT is invalid.');
if (!/^https?:\/\//i.test(timestampServer)) throw new Error('WINDOWS_TIMESTAMP_SERVER must be an HTTP(S) RFC 3161 endpoint.');

const signingBase = {
  ...(certificateFile ? { certificateFile } : {}),
  ...(certificatePassword ? { certificatePassword } : {}),
  timestampServer,
  description: 'TTcut',
  ...(signToolPath ? { signToolPath } : {}),
  ...(certificateThumbprint ? {
    automaticallySelectCertificate: false,
    signWithParams: ['/sha1', certificateThumbprint],
  } : customSigningParams ? { signWithParams: customSigningParams } : {}),
  ...(process.env.TTCUT_PUBLISHER_WEBSITE ? { website: process.env.TTCUT_PUBLISHER_WEBSITE } : {}),
};
const packagerWindowsSign = signingConfigured ? {
  ...signingBase,
  hashes: ['sha256'] as NonNullable<EsmSignToolOptions['hashes']>,
} : undefined;

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    icon: path.resolve(macBuild ? 'macos/Resources/TTcut.icns' : 'public/ttcut.ico'),
    ...(macBuild ? { appBundleId: 'com.weiye.ttcut.electron.macos', appCategoryType: 'public.app-category.video', extendInfo: { LSMinimumSystemVersion: '15.0' } } : {}),
    executableName: 'TTcut',
    ignore: ignoreUnbuiltSource,
    afterExtract: [retainSupportedWindowsLocales],
    extraResource: macBuild ? ['.runtime/macos'] : [
      '.runtime/worker',
      '.runtime/release-metadata',
      onlineModelInstaller ? '.runtime/online-installer/resources' : 'resources',
    ],
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
      ...(electronWin32X64Checksums ? { checksums: electronWin32X64Checksums } : {}),
    },
  },
  rebuildConfig: {},
  makers: [],
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
