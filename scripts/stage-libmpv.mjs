import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, copyFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

if (process.platform !== 'win32') process.exit(0);
const root = path.resolve(import.meta.dirname, '..');
const spec = JSON.parse(await readFile(path.join(root, 'resources/libmpv.json'), 'utf8'));
const cache = path.join(root, '.baseline/libmpv');
const destination = path.join(root, '.runtime/libmpv');
await mkdir(cache, { recursive: true }); await mkdir(destination, { recursive: true });
const hash = data => createHash('sha256').update(data).digest('hex');
async function verified(file, digest) { return existsSync(file) && hash(await readFile(file)) === digest; }
async function acquire(url, file, digest) {
  if (await verified(file, digest)) return;
  console.log('Downloading pinned playback dependency:', path.basename(file));
  execFileSync('curl.exe', ['--fail', '--location', '--retry', '2', '--max-time', '1200', '--output', file, url], { stdio: 'inherit', windowsHide: true });
  if (!await verified(file, digest)) throw new Error('Playback dependency checksum mismatch: ' + file);
}
const archive = path.join(cache, path.basename(new URL(spec.url).pathname));
await acquire(spec.url, archive, spec.sha256);
const jsonHeader = path.join(cache, 'json.hpp');
await acquire(spec.jsonUrl, jsonHeader, spec.jsonSha256);
const sdk = path.join(cache, 'sdk'); await mkdir(sdk, { recursive: true });
const marker = path.join(sdk, 'archive.sha256');
if (!existsSync(marker) || (await readFile(marker, 'utf8')) !== spec.sha256) {
  execFileSync('tar.exe', ['-xf', archive, '-C', sdk], { stdio: 'inherit', windowsHide: true });
  await writeFile(marker, spec.sha256);
}
async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]))).flat();
}
const sdkFiles = await files(sdk);
const dll = sdkFiles.find(file => path.basename(file) === 'libmpv-2.dll');
const header = sdkFiles.find(file => file.replaceAll('\\', '/').endsWith('/mpv/client.h'));
if (!dll || !header) throw new Error('Pinned libmpv archive has an unexpected layout');
if (!await verified(path.join(destination, 'libmpv-2.dll'), hash(await readFile(dll)))) await copyFile(dll, path.join(destination, 'libmpv-2.dll'));
for (const file of sdkFiles.filter(file => /^(copyright|copying|license)/i.test(path.basename(file)))) await copyFile(file, path.join(destination, path.basename(file)));
await copyFile(path.join(root, 'resources/libmpv.json'), path.join(destination, 'libmpv.json'));
const licenses = path.join(root, 'resources/libmpv-licenses');
await mkdir(path.join(destination, 'licenses'), { recursive: true });
for (const name of await readdir(licenses)) await copyFile(path.join(licenses, name), path.join(destination, 'licenses', name));
const source = path.join(root, 'native/preview/main.cpp');
const buildHash = hash(Buffer.concat([await readFile(source), await readFile(path.join(root, 'scripts/stage-libmpv.mjs')), Buffer.from(JSON.stringify(spec))]));
const exe = path.join(destination, 'ttcut-preview.exe');
const manifestPath = path.join(destination, 'manifest.json');
const previous = existsSync(manifestPath) ? JSON.parse(await readFile(manifestPath, 'utf8')) : {};
if (!existsSync(exe) || previous.buildHash !== buildHash || !await verified(exe, previous.exeSha256)) {
  const vswhere = path.join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'Microsoft Visual Studio/Installer/vswhere.exe');
  const vs = execFileSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8', windowsHide: true }).trim();
  if (!vs) throw new Error('Visual Studio C++ x64 Build Tools are required to build the preview host');
  const vcvars = path.join(vs, 'VC/Auxiliary/Build/vcvars64.bat');
  const envText = execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${vcvars}" >nul && set"`], { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true });
  const env = { ...process.env };
  for (const line of envText.split(/\r?\n/)) { const index = line.indexOf('='); if (index > 0) env[line.slice(0, index)] = line.slice(index + 1); }
  const compiler = path.join(env.VCToolsInstallDir, 'bin/Hostx64/x64/cl.exe');
  execFileSync(compiler, ['/nologo', '/std:c++17', '/EHsc', '/O2', '/MT', '/utf-8', '/DUNICODE', '/D_UNICODE', '/I' + path.dirname(path.dirname(header)), '/I' + cache, source, '/Fo' + path.join(cache, 'preview.obj'), '/Fe' + exe, '/link', 'user32.lib', 'gdi32.lib', '/DYNAMICBASE', '/NXCOMPAT'], { cwd: cache, env, stdio: 'inherit', windowsHide: true });
}
await writeFile(manifestPath, JSON.stringify({ version: spec.version, buildHash, exeSha256: hash(await readFile(exe)), dllSha256: hash(await readFile(dll)), archiveSha256: spec.sha256 }, null, 2));
console.log('Pinned libmpv preview runtime ready:', destination);
