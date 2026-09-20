import { createHash } from 'node:crypto';
import { copyFile, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const releaseDirectory = join(projectRoot, 'out', 'make', 'nsis', 'x64');
const sbomSourcePath = join(projectRoot, '.runtime', 'release-metadata', 'sbom.cdx.json');
const sbomDestinationPath = join(releaseDirectory, 'sbom.cdx.json');
const sumsPath = join(releaseDirectory, 'SHA256SUMS.txt');

async function sha256(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

const names = await readdir(releaseDirectory);
const setupName = names.find((name) => /-Setup\.exe$/i.test(name));
if (!setupName) throw new Error(`NSIS Setup is missing from ${releaseDirectory}.`);

const requiredNames = [
  setupName,
  `${setupName}.blockmap`,
  names.find((name) => /^(latest|beta)\.yml$/i.test(name)),
  'update-manifest.json',
  'update-manifest.json.sig',
];
if (requiredNames.some((name) => !name)) {
  throw new Error('NSIS blockmap or signed update metadata is missing.');
}
if (names.some((name) => /\.nupkg$/i.test(name) || name === 'RELEASES')) {
  throw new Error('Squirrel artifacts must not be included in the NSIS release contract.');
}

await stat(sbomSourcePath);
await copyFile(sbomSourcePath, sbomDestinationPath);
const releaseFiles = [...requiredNames.map((name) => join(releaseDirectory, name)), sbomDestinationPath];
const lines = [];
for (const filePath of releaseFiles) {
  lines.push(`${await sha256(filePath)}  ${basename(filePath)}`);
}
await writeFile(sumsPath, `${lines.join('\n')}\n`, 'utf8');

console.log(`NSIS release assets prepared in ${releaseDirectory}`);
for (const filePath of [...releaseFiles, sumsPath]) {
  const fileStat = await stat(filePath);
  console.log(`${basename(filePath)}: ${fileStat.size} bytes, sha256=${await sha256(filePath)}`);
}
