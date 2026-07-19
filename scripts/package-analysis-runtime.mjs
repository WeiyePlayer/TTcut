import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [variant, sourceArgument] = process.argv.slice(2);
if (!['cpu', 'cu126'].includes(variant) || !sourceArgument) {
  throw new Error('Usage: node scripts/package-analysis-runtime.mjs <cpu|cu126> <prepared-runtime-directory>');
}

const runtimeId = '3.12.13-2.12.1';
const archiveRoot = `ttcut-analysis-${runtimeId}-${variant}`;
const source = await realpath(path.resolve(sourceArgument));
const sourceInfo = await stat(source);
if (!sourceInfo.isDirectory() || path.basename(source) !== archiveRoot) {
  throw new Error(`Prepared runtime directory must be named exactly ${archiveRoot}.`);
}
if (source === path.parse(source).root || source === root) throw new Error('Refusing to package a broad filesystem root.');

const python = path.join(source, 'python.exe');
if (!(await stat(python).catch(() => null))?.isFile()) throw new Error('Prepared runtime is missing python.exe.');
const check = spawnSync(python, ['-c', 'import cv2,json,numpy,sys,torch;print(json.dumps({"python":sys.version.split()[0],"torch":torch.__version__,"cuda":torch.version.cuda,"opencv":cv2.__version__,"numpy":numpy.__version__,"available":torch.cuda.is_available()}))'], {
  cwd: source,
  encoding: 'utf8',
  windowsHide: true,
  timeout: 60_000,
});
if (check.status !== 0) throw new Error(`Prepared runtime self-test failed: ${check.stderr || check.stdout}`);
const versions = JSON.parse(check.stdout.trim());
const expectedTorch = `2.12.1+${variant}`;
if (versions.python !== '3.12.13' || versions.torch !== expectedTorch || versions.numpy !== '2.5.1' || versions.opencv !== '4.13.0') {
  throw new Error(`Prepared runtime versions do not match the locked catalog: ${check.stdout.trim()}`);
}
if (variant === 'cpu' && (versions.cuda !== null || versions.available !== false)) throw new Error('CPU runtime unexpectedly contains a CUDA build.');
if (variant === 'cu126' && (versions.cuda !== '12.6' || versions.available !== true)) throw new Error('CUDA runtime cannot complete its CUDA self-test on this release machine.');

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(absolute));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

const relativeFiles = (await walk(source)).map((file) => path.relative(source, file).replaceAll('\\', '/').toLowerCase());
if (relativeFiles.some((file) => /(^|\/)tracknet_best\.pt$/.test(file))) throw new Error('Runtime archive must not contain the TrackNet weight.');
for (const pattern of [
  /^license\.txt$/,
  /torch-[^/]+\.dist-info\/(?:licenses\/)?license/,
  /numpy-[^/]+\.dist-info\/licenses\/license/,
  /opencv_python-[^/]+\.dist-info\/license/,
]) {
  if (!relativeFiles.some((file) => pattern.test(file))) throw new Error(`Prepared runtime is missing a required license body: ${pattern}`);
}

const outputDirectory = path.join(root, '.baseline', 'runtime-assets');
await mkdir(outputDirectory, { recursive: true });
const archive = path.join(outputDirectory, `${archiveRoot}.zip`);
const packed = spawnSync('tar.exe', ['-a', '-cf', archive, '-C', path.dirname(source), archiveRoot], {
  encoding: 'utf8',
  windowsHide: true,
  timeout: 30 * 60_000,
});
if (packed.status !== 0) throw new Error(`Runtime archive creation failed: ${packed.stderr || packed.stdout}`);

const hash = createHash('sha256');
for await (const chunk of createReadStream(archive)) hash.update(chunk);
const descriptor = {
  variant,
  provider: 'TTcut release pipeline',
  asset: path.basename(archive),
  archive_root: archiveRoot,
  install_directory: `analysis-runtime/${runtimeId}/${variant}`,
  url: `https://REPLACE-WITH-IMMUTABLE-HOST/${path.basename(archive)}`,
  size_bytes: (await stat(archive)).size,
  sha256: hash.digest('hex'),
};
await writeFile(`${archive}.json`, `${JSON.stringify(descriptor, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ archive, descriptor }, null, 2));
