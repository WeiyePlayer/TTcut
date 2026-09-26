import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const independentBeta = process.env.TTCUT_INDEPENDENT_BETA === '1';
const productName = independentBeta ? 'TTcut Beta' : 'TTcut';
const executableName = independentBeta ? 'TTcut Beta.exe' : 'TTcut.exe';
const packaged = path.join(root, 'out', `${productName}-win32-x64`);
const output = path.join(root, 'out', 'make', independentBeta ? 'nsis-beta' : 'nsis', 'x64');
const assets = path.join(root, '.runtime', 'installer-assets');
const official = process.env.TTCUT_OFFICIAL_RELEASE === '1' || process.env.TTCUT_PUBLIC_RC === '1';
const packageJson = require('../package.json');
const packageVersion = packageJson.version;
const updatePublisherName = packageJson.author;
const updateChannel = packageVersion.includes('-') ? 'beta' : 'latest';

if (updatePublisherName !== 'weiye') {
  throw new Error('The Windows update publisher must be weiye.');
}

const { api } = require('@electron-forge/core');
await api.package({ dir: root, arch: 'x64', interactive: false });
if (!existsSync(path.join(packaged, executableName))) throw new Error(`Packaged ${productName} executable is missing: ${packaged}`);
// Electron Packager re-signs some Microsoft runtime DLLs, changing their bytes
// after the runtime manifest is generated. Restore the exact staged DLLs before
// NSIS captures the package; release verification checks their recorded hashes.
const runtimeRoot = path.join(root, '.runtime', 'windows');
const runtimeManifest = JSON.parse(await readFile(path.join(runtimeRoot, 'runtime-manifest.json'), 'utf8'));
for (const relative of Object.keys(runtimeManifest.files ?? {}).filter((name) => /^python\/[^/]+\.dll$/i.test(name))) {
  const segments = relative.split('/');
  await copyFile(path.join(runtimeRoot, ...segments), path.join(packaged, 'resources', 'windows', ...segments));
}
if (!independentBeta) {
  await writeFile(path.join(packaged, 'resources', 'app-update.yml'), [
    'provider: github',
    'owner: WeiyePlayer',
    'repo: TTcut',
    `channel: ${updateChannel}`,
    `publisherName: ${updatePublisherName}`,
    'updaterCacheDirName: ttcut-updater',
    '',
  ].join('\n'), 'utf8');
}

await mkdir(assets, { recursive: true });
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
const verificationUninstaller = path.join(verificationDirectory, `Uninstall ${productName}.exe`);
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
if (!artifacts.some((name) => name.endsWith('-Setup.exe'))) {
  throw new Error('NSIS Setup artifact is missing.');
}
if (!independentBeta && !artifacts.some((name) => name.endsWith('.yml'))) throw new Error('NSIS update metadata is missing.');
if (independentBeta) {
  const setupArtifact = artifacts.find((name) => name.endsWith('-Setup.exe'));
  await Promise.all(artifacts
    .filter((name) => name !== setupArtifact)
    .map((name) => rm(path.join(output, name), { force: true })));
  await rm(verificationDirectory, { recursive: true, force: true });
  console.log(`Created independent Beta installer: ${path.join(output, setupArtifact)}`);
} else {
  for (const artifact of artifacts) console.log(`Created NSIS artifact: ${path.join(output, artifact)}`);
}
