import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot = path.join(root, '.runtime');
const destination = path.join(runtimeRoot, 'release-metadata');
const staging = path.join(runtimeRoot, `.release-metadata-${randomUUID()}`);

if (path.dirname(destination) !== runtimeRoot || path.dirname(staging) !== runtimeRoot) {
  throw new Error('Refusing to generate release metadata outside .runtime.');
}

function packageNameFromLockPath(lockPath) {
  const marker = 'node_modules/';
  const offset = lockPath.lastIndexOf(marker);
  return lockPath.slice(offset + marker.length);
}

function safeName(value) {
  return value.replace(/^@/, '').replaceAll('/', '__').replace(/[^A-Za-z0-9._-]/g, '_');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

async function licenseFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /^(?:licen[cs]e|copying|notice)(?:[._-].*|$)/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

await rm(staging, { recursive: true, force: true });
await mkdir(path.join(staging, 'licenses', 'npm'), { recursive: true });
await mkdir(path.join(staging, 'licenses', 'tracknet'), { recursive: true });

const packageLock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
const componentCatalog = JSON.parse(await readFile(path.join(root, 'resources', 'components.json'), 'utf8'));
const modelManifest = JSON.parse(await readFile(path.join(root, 'resources', 'model-manifest.json'), 'utf8'));
const selected = Object.entries(packageLock.packages ?? {})
  .filter(([lockPath, metadata]) => lockPath.startsWith('node_modules/') && (metadata.dev !== true || lockPath === 'node_modules/electron'));
const components = [];
const missingLicenses = [];

for (const [lockPath, lockMetadata] of selected) {
  const directory = path.join(root, ...lockPath.split('/'));
  const packageJson = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  const name = packageJson.name ?? packageNameFromLockPath(lockPath);
  const version = packageJson.version ?? lockMetadata.version;
  const declaredLicense = packageJson.license ?? lockMetadata.license ?? 'NOASSERTION';
  const files = await licenseFiles(directory);
  if (!files.length) {
    missingLicenses.push(`${name}@${version}`);
    continue;
  }
  const packageDestination = path.join(staging, 'licenses', 'npm', safeName(name));
  await mkdir(packageDestination, { recursive: true });
  for (const file of files) await cp(path.join(directory, file), path.join(packageDestination, file));
  components.push({
    type: 'library',
    name,
    version,
    licenses: [{ license: { id: declaredLicense } }],
    purl: `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`,
    evidence: { occurrences: [{ location: lockPath }] },
    license_files: files.map((file) => `licenses/npm/${safeName(name)}/${file}`),
  });
}

if (missingLicenses.length) {
  throw new Error(`Production packages without a bundled license body: ${missingLicenses.join(', ')}`);
}

await cp(path.join(root, 'worker', 'LICENSE.tracknet.txt'), path.join(staging, 'licenses', 'tracknet', 'LICENSE.txt'));
await cp(path.join(root, 'THIRD_PARTY_NOTICES.md'), path.join(staging, 'THIRD_PARTY_NOTICES.md'));
components.push({
  type: 'library',
  name: 'TrackNetV3-derived worker source',
  version: '40d4d26bc85802d5925ead6b1fd0ad3c6a8a84ba',
  licenses: [{ license: { id: 'MIT' } }],
  license_files: ['licenses/tracknet/LICENSE.txt'],
});
for (const model of modelManifest.models) {
  components.push({
    type: 'machine-learning-model',
    name: model.filename,
    version: `sha256:${model.sha256}`,
    hashes: [{ alg: 'SHA-256', content: model.sha256 }],
    licenses: [{ license: { name: 'NOASSERTION' } }],
    properties: [
      { name: 'ttcut:model-id', value: model.model_id },
      { name: 'ttcut:distribution', value: 'installer-resource' },
      { name: 'ttcut:installer-bundled', value: 'true' },
      { name: 'ttcut:resource-path', value: `resources/models/${model.filename}` },
    ],
    license_files: ['THIRD_PARTY_NOTICES.md'],
  });
}
components.push({
  type: 'framework',
  name: 'FFmpeg libx264 optional media component',
  version: componentCatalog.ffmpeg_x264.version_line,
  scope: 'optional',
  hashes: [{ alg: 'SHA-256', content: componentCatalog.ffmpeg_x264.sha256 }],
  licenses: [{ license: { id: 'GPL-3.0-only' } }],
  externalReferences: [
    { type: 'distribution', url: componentCatalog.ffmpeg_x264.url },
    { type: 'vcs', url: componentCatalog.ffmpeg_x264.source_url },
    { type: 'website', url: componentCatalog.ffmpeg_x264.license_url },
  ],
  properties: [
    { name: 'ttcut:distribution', value: 'manual-import-only' },
    { name: 'ttcut:installer-bundled', value: 'false' },
    { name: 'ttcut:encoder', value: 'libx264' },
  ],
  license_files: ['THIRD_PARTY_NOTICES.md'],
});

components.sort((left, right) => left.name.localeCompare(right.name));
const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.6',
  serialNumber: `urn:uuid:${randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    component: { type: 'application', name: 'TTcut', version: packageLock.packages?.['']?.version ?? '1.0.0' },
  },
  components: components.map(({ license_files: _licenseFiles, ...component }) => component),
};
await writeFile(path.join(staging, 'sbom.cdx.json'), `${JSON.stringify(sbom, null, 2)}\n`, 'utf8');
await writeFile(path.join(staging, 'licenses', 'index.json'), `${JSON.stringify({ schema_version: 1, components }, null, 2)}\n`, 'utf8');

const rows = components.map((component) => {
  const links = component.license_files.map((file) => `<a href="${escapeHtml(file)}">${escapeHtml(path.basename(file))}</a>`).join(', ');
  const license = component.licenses.map((item) => item.license.id ?? item.license.name).join(', ');
  return `<tr><td>${escapeHtml(component.name)}</td><td>${escapeHtml(component.version)}</td><td>${escapeHtml(license)}</td><td>${links}</td></tr>`;
}).join('\n');
await writeFile(path.join(staging, 'THIRD_PARTY_NOTICES.html'), `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>TTcut 第三方许可证</title><style>body{font:14px/1.55 system-ui,sans-serif;max-width:1100px;margin:32px auto;padding:0 24px;color:#222}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px;text-align:left;vertical-align:top}th{background:#f3f3f3}code{font-family:ui-monospace,monospace}</style></head>
<body><h1>TTcut 第三方许可证</h1><p>本页列出桌面应用、随安装器分发的模型资源及受管下载组件的许可证材料。按需下载的 Python、PyTorch、NumPy、OpenCV 与 FFmpeg 组件在各自受管组件目录中保留随包许可证；固定模型随应用安装，并在打包前执行大小和 SHA-256 校验。</p>
<table><thead><tr><th>组件</th><th>版本</th><th>声明的许可证</th><th>许可证正文</th></tr></thead><tbody>${rows}</tbody></table>
<p>机器可读清单：<a href="sbom.cdx.json">sbom.cdx.json</a> · <a href="licenses/index.json">licenses/index.json</a> · <a href="THIRD_PARTY_NOTICES.md">第三方说明</a></p></body></html>`, 'utf8');

await rm(destination, { recursive: true, force: true });
await rename(staging, destination);
console.log(`Generated release metadata for ${components.length} shipped components: ${destination}`);
