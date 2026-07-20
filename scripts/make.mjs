import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildState = path.join(root, '.runtime', 'build-state');
const nugetConfig = path.join(buildState, 'NuGet.Config');
const packages = path.join(buildState, 'nuget-packages');
const httpCache = path.join(buildState, 'nuget-http-cache');
const buildTools = path.join(root, '.runtime', 'build-tools');
const nugetExecutable = path.join(buildTools, 'nuget-7.0.3.exe');
const nugetUrl = 'https://dist.nuget.org/win-x86-commandline/v7.0.3/nuget.exe';
const nugetSha256 = '94cd179bddf355fa5e5733a6dd38a3229e4c6461247b348689c95bcc344ee02e';

async function sha256(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

async function ensureNuGet() {
  await mkdir(buildTools, { recursive: true });
  if (existsSync(nugetExecutable) && await sha256(nugetExecutable) === nugetSha256) return;
  const partial = `${nugetExecutable}.partial`;
  await rm(partial, { force: true });
  const response = await fetch(nugetUrl);
  if (!response.ok) throw new Error(`NuGet download failed with HTTP ${response.status}.`);
  await writeFile(partial, Buffer.from(await response.arrayBuffer()));
  const actual = await sha256(partial);
  if (actual !== nugetSha256) {
    await rm(partial, { force: true });
    throw new Error(`NuGet SHA-256 mismatch: ${actual}`);
  }
  await rename(partial, nugetExecutable);
}

await Promise.all([
  mkdir(buildState, { recursive: true }),
  mkdir(packages, { recursive: true }),
  mkdir(httpCache, { recursive: true }),
]);
await writeFile(nugetConfig, [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<configuration>',
  '  <packageSources><clear /></packageSources>',
  '</configuration>',
  '',
].join('\n'), 'utf8');
await ensureNuGet();

const originalSpawn = childProcess.spawn;
childProcess.spawn = (executable, args = [], options) => {
  const nugetPack = path.basename(String(executable)).toLowerCase() === 'nuget.exe' && args[0] === 'pack';
  const nextArgs = nugetPack && !args.includes('-ConfigFile')
    ? [...args, '-ConfigFile', nugetConfig]
    : args;
  return originalSpawn(nugetPack ? nugetExecutable : executable, nextArgs, options);
};

const previousPackages = process.env.NUGET_PACKAGES;
const previousHttpCache = process.env.NUGET_HTTP_CACHE_PATH;
process.env.NUGET_PACKAGES = packages;
process.env.NUGET_HTTP_CACHE_PATH = httpCache;
try {
  const { api } = require('@electron-forge/core');
  const results = await api.make({ dir: root, arch: 'x64', interactive: false });
  for (const result of results) {
    for (const artifact of result.artifacts) console.log(`Created installer artifact: ${artifact}`);
  }
  if (process.env.TTCUT_PUBLIC_RC === '1' || process.env.TTCUT_OFFICIAL_RELEASE === '1') {
    const verification = childProcess.spawnSync(process.execPath, [path.join(root, 'scripts', 'verify-signatures.mjs')], {
      cwd: root,
      env: process.env,
      stdio: 'inherit',
      windowsHide: true,
    });
    if (verification.status !== 0) throw new Error('Public release signature verification failed.');
  }
} finally {
  childProcess.spawn = originalSpawn;
  if (previousPackages === undefined) delete process.env.NUGET_PACKAGES;
  else process.env.NUGET_PACKAGES = previousPackages;
  if (previousHttpCache === undefined) delete process.env.NUGET_HTTP_CACHE_PATH;
  else process.env.NUGET_HTTP_CACHE_PATH = previousHttpCache;
}
