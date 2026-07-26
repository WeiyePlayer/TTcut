import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');
const { convertVersion } = require('electron-winstaller');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const publicRelease = process.env.TTCUT_PUBLIC_RC === '1' || process.env.TTCUT_OFFICIAL_RELEASE === '1';

function runMakeChild() {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(process.execPath, [path.join(root, 'scripts', 'make.mjs')], {
      cwd: root,
      env: process.env,
      stdio: ['inherit', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    const capture = (target, chunk) => {
      target.write(chunk);
      output = `${output}${chunk}`.slice(-200_000);
    };
    child.stdout.on('data', (chunk) => capture(process.stdout, chunk));
    child.stderr.on('data', (chunk) => capture(process.stderr, chunk));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

async function recoverLocalSquirrelArtifacts(output) {
  if (publicRelease || !output.includes('Failed to modify resources') || !output.includes('rcedit.exe')) return false;

  const outputDirectory = path.join(root, 'out', 'make', 'squirrel.windows', 'x64');
  const setupSource = path.join(outputDirectory, 'Setup.exe');
  const setupTarget = path.join(outputDirectory, `${packageJson.productName}-${packageJson.version}-x64-Setup.exe`);
  const releases = path.join(outputDirectory, 'RELEASES');
  const fullPackage = path.join(outputDirectory, `${packageJson.productName}-${convertVersion(packageJson.version)}-full.nupkg`);
  if (![setupSource, releases, fullPackage].every((filePath) => existsSync(filePath))) return false;

  const publisher = typeof packageJson.author === 'string' ? packageJson.author : packageJson.author?.name;
  const rcedit = path.join(root, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe');
  const result = childProcess.spawnSync(rcedit, [
    path.relative(root, setupSource),
    '--set-version-string', 'CompanyName', publisher || 'weiye',
    '--set-version-string', 'LegalCopyright', `Copyright © 2026 ${publisher || 'weiye'}`,
    '--set-version-string', 'FileDescription', packageJson.description,
    '--set-version-string', 'ProductName', packageJson.description,
    '--set-file-version', packageJson.version,
    '--set-product-version', packageJson.version,
  ], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`Local Squirrel recovery failed: ${result.stderr || result.stdout || result.error || 'unknown rcedit error'}`);
  }
  await rm(setupTarget, { force: true });
  await rename(setupSource, setupTarget);
  console.warn('Recovered local Squirrel artifacts after the Forge child process released Setup.exe.');
  for (const artifact of [releases, setupTarget, fullPackage]) console.log(`Created installer artifact: ${artifact}`);
  return true;
}

const result = await runMakeChild();
if (result.code !== 0 && !await recoverLocalSquirrelArtifacts(result.output)) process.exitCode = result.code;
