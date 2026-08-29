import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packaged = path.join(root, 'out', 'TTcut-win32-x64');
const onlineModelInstaller = process.env.TTCUT_ONLINE_MODEL_INSTALLER === '1';
const output = path.join(root, 'out', 'make', onlineModelInstaller ? 'nsis-online' : 'nsis', 'x64');
const assets = path.join(root, '.runtime', 'installer-assets');
const official = process.env.TTCUT_OFFICIAL_RELEASE === '1' || process.env.TTCUT_PUBLIC_RC === '1';
const packageJson = require('../package.json');
const packageVersion = packageJson.version;
const updatePublisherName = packageJson.author;
const updateChannel = packageVersion.includes('-') ? 'beta' : 'latest';

if (updatePublisherName !== 'weiye') {
  throw new Error('The Windows update publisher must be weiye.');
}

if (onlineModelInstaller) {
  const stageResult = spawnSync(process.execPath, [
    path.join(root, 'scripts', 'stage-online-installer-resources.mjs'),
  ], { cwd: root, encoding: 'utf8' });
  if (stageResult.status !== 0) {
    throw new Error(`Online installer resource staging failed: ${stageResult.stderr || stageResult.stdout}`);
  }
  process.stdout.write(stageResult.stdout);
}

const { api } = require('@electron-forge/core');
await api.package({ dir: root, arch: 'x64', interactive: false });
if (!existsSync(path.join(packaged, 'TTcut.exe'))) throw new Error(`Packaged TTcut executable is missing: ${packaged}`);
await writeFile(path.join(packaged, 'resources', 'app-update.yml'), [
  'provider: github',
  'owner: WeiyePlayer',
  'repo: TTcut',
  `channel: ${updateChannel}`,
  `publisherName: ${updatePublisherName}`,
  'updaterCacheDirName: ttcut-updater',
  '',
].join('\n'), 'utf8');

await mkdir(assets, { recursive: true });
await writeFile(
  path.join(assets, 'online-model-installer.nsh'),
  `!define TTCUT_ONLINE_MODEL_INSTALLER ${onlineModelInstaller ? '1' : '0'}\n`,
  'utf8',
);
const powerShellExecutable = process.env.TTCUT_POWERSHELL_PATH
  ?? path.join(process.env.ProgramW6432 ?? process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
const assetResult = spawnSync(powerShellExecutable, [
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy', 'Bypass',
  '-File', path.join(root, 'scripts', 'generate-installer-assets.ps1'),
  '-OutputDirectory', assets,
], { cwd: root, encoding: 'utf8', windowsHide: true });
if (assetResult.status !== 0) throw new Error(`Installer asset generation failed: ${assetResult.stderr || assetResult.stdout}`);
process.stdout.write(assetResult.stdout);

const resolvedOutput = path.resolve(output);
if (!resolvedOutput.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('Refusing to clear an installer output outside the workspace.');
await rm(resolvedOutput, { recursive: true, force: true });
await mkdir(resolvedOutput, { recursive: true });

const cli = require.resolve('electron-builder/out/cli/cli.js');
const environment = { ...process.env };
if (!official) environment.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
const builder = spawn(process.execPath, [
  cli,
  '--win', 'nsis',
  '--x64',
  '--prepackaged', packaged,
  '--config', path.join(root, 'electron-builder.config.cjs'),
], {
  cwd: root,
  env: environment,
  windowsHide: true,
  stdio: 'inherit',
});
let builderExitCode = null;
builder.once('exit', (code) => { builderExitCode = code ?? -1; });
builder.once('error', () => { builderExitCode = -1; });

const verificationDirectory = path.join(output, '.verification');
const verificationUninstaller = path.join(verificationDirectory, 'Uninstall TTcut.exe');
let capturedUninstaller = false;
async function captureSignedUninstaller() {
  const candidate = (await readdir(output).catch(() => []))
    .find((name) => name.endsWith('-Setup.__uninstaller.exe'));
  if (!candidate) return;
  const candidatePath = path.join(output, candidate);
  if ((await stat(candidatePath)).size === 0) return;
  await mkdir(verificationDirectory, { recursive: true });
  await copyFile(candidatePath, verificationUninstaller);
  capturedUninstaller = true;
}

while (builderExitCode === null) {
  await captureSignedUninstaller().catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 50));
}
await captureSignedUninstaller().catch(() => undefined);
if (builderExitCode !== 0) throw new Error(`NSIS build failed with exit code ${builderExitCode}.`);
if (!capturedUninstaller || !existsSync(verificationUninstaller)) {
  throw new Error('The generated NSIS uninstaller was not captured for signature verification.');
}

const artifacts = (await readdir(output))
  .filter((name) => /\.(exe|blockmap|yml)$/i.test(name))
  .sort();
if (!artifacts.some((name) => onlineModelInstaller ? name.endsWith('-Online-Setup.exe') : name.endsWith('-Setup.exe'))) {
  throw new Error('NSIS Setup artifact is missing.');
}
if (!artifacts.some((name) => name.endsWith('.yml'))) throw new Error('NSIS update metadata is missing.');
for (const artifact of artifacts) console.log(`Created NSIS artifact: ${path.join(output, artifact)}`);
