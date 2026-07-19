import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { listPackage } = require('@electron/asar');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(absolute));
    else files.push(absolute);
  }
  return files;
}

async function auditWorker(directory, label) {
  check(existsSync(directory), `${label} is missing: ${directory}`);
  if (!existsSync(directory)) return;
  const files = await walk(directory);
  const relative = files.map((file) => path.relative(directory, file).replaceAll('\\', '/'));
  const forbiddenPaths = relative.filter((file) => (
    /(^|\/)(tests?|__pycache__)(\/|$)/i.test(file)
    || /\.(pyc|pt|pth)$/i.test(file)
    || /(inpaint|speed|hit.?detect|overlay|gradio|webui)/i.test(file)
  ));
  check(forbiddenPaths.length === 0, `${label} contains non-runtime files: ${forbiddenPaths.join(', ')}`);

  const pythonFiles = files.filter((file) => file.endsWith('.py'));
  const runtimeText = (await Promise.all(pythonFiles.map((file) => readFile(file, 'utf8')))).join('\n').toLowerCase();
  for (const token of ['inpaintnet', 'speed_analysis', 'hit_detection', 'overlay_renderer', 'gradio']) {
    check(!runtimeText.includes(token), `${label} imports or references removed feature: ${token}`);
  }
  for (const name of ['requirements-cpu.txt', 'requirements-cu126.txt', 'runtime-wheel-lock.json', 'SOURCE_MANIFEST.md', 'LICENSE.tracknet.txt']) {
    check(relative.includes(name), `${label} is missing ${name}`);
  }
  for (const requirement of ['requirements-cpu.txt', 'requirements-cu126.txt']) {
    const text = await readFile(path.join(directory, requirement), 'utf8');
    check(text.includes('numpy==2.5.1'), `${label}/${requirement} does not pin NumPy exactly.`);
    check(text.includes('opencv-python==4.13.0.92'), `${label}/${requirement} does not pin OpenCV exactly.`);
    const packageLines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('--'));
    check(packageLines.every((line) => /^[A-Za-z0-9._-]+==[^<>=~!\s]+$/.test(line)), `${label}/${requirement} contains a non-exact package range.`);
    for (const dependency of ['pillow', 'pandas', 'pyyaml', 'tqdm', 'psutil', 'torchvision', 'gradio']) {
      check(!new RegExp(`^\\s*${dependency}(?:[<=>~!]|\\s|$)`, 'im').test(text), `${label}/${requirement} contains ${dependency}`);
    }
  }
  const wheelLock = JSON.parse(await readFile(path.join(directory, 'runtime-wheel-lock.json'), 'utf8'));
  check(wheelLock.platform === 'win_amd64' && wheelLock.python_tag === 'cp312', `${label}/runtime-wheel-lock.json targets the wrong platform.`);
  const lockedNames = new Set(wheelLock.wheels?.map((wheel) => `${wheel.name.toLowerCase()}:${wheel.version}`));
  for (const required of ['numpy:2.5.1', 'opencv-python:4.13.0.92', 'torch:2.12.1+cpu', 'torch:2.12.1+cu126', 'filelock:3.30.3', 'fsspec:2026.6.0', 'jinja2:3.1.6', 'markupsafe:3.0.3', 'mpmath:1.3.0', 'networkx:3.6.1', 'setuptools:81.0.0', 'sympy:1.14.0', 'typing-extensions:4.16.0']) {
    check(lockedNames.has(required), `${label}/runtime-wheel-lock.json is missing ${required}.`);
  }
  check(wheelLock.wheels.every((wheel) => Array.isArray(wheel.variants) && wheel.variants.length > 0 && wheel.url.startsWith('https://') && /^[a-f0-9]{64}$/.test(wheel.sha256) && Number.isSafeInteger(wheel.size_bytes) && wheel.size_bytes > 0), `${label}/runtime-wheel-lock.json contains an unpinned wheel.`);
}

const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const allDependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
for (const dependency of ['gradio', 'pillow', 'pandas', 'pyyaml', 'tqdm', 'psutil', 'torchvision']) {
  check(!(dependency in allDependencies), `package.json contains removed dependency: ${dependency}`);
}

const mainSource = await readFile(path.join(root, 'src', 'main', 'index.ts'), 'utf8');
check(
  mainSource.includes("return !app.isPackaged && process.env.TTCUT_E2E === '1';"),
  'E2E hooks are not hard-gated behind !app.isPackaged.',
);
check(mainSource.includes('contextIsolation: true'), 'Renderer contextIsolation is not enabled.');
check(mainSource.includes('nodeIntegration: false'), 'Renderer Node integration is not disabled.');
check(mainSource.includes('sandbox: true'), 'Renderer sandbox is not enabled.');

const componentSource = await readFile(path.join(root, 'src', 'main', 'components.ts'), 'utf8');
check(
  componentSource.includes("!app.isPackaged && process.env.TTCUT_E2E === '1' && process.env.TTCUT_E2E_COMPONENTS_ROOT"),
  'The E2E component-root override is not hard-gated behind !app.isPackaged.',
);
check(
  componentSource.includes("process.env.TTCUT_E2E === '1' && process.env.TTCUT_E2E_DISABLE_DEV_COMPONENTS === '1'"),
  'The development-component suppression hook is not restricted to E2E.',
);
const componentManagerSource = await readFile(path.join(root, 'src', 'main', 'component-manager.ts'), 'utf8');
const componentsSource = await readFile(path.join(root, 'src', 'main', 'components.ts'), 'utf8');
check(componentsSource.includes("path.join(localAppData, 'TTcutData', 'components')"), 'Managed components share the Squirrel application install root and can be deleted during upgrade.');
const offlineSurface = (await Promise.all([
  'src/main/index.ts',
  'src/main/component-manager.ts',
  'src/preload/index.ts',
  'src/renderer/App.tsx',
  'src/renderer/i18n.ts',
  'src/shared/api.ts',
  'src/shared/contracts.ts',
  'src/shared/ipc.ts',
].map((relative) => readFile(path.join(root, ...relative.split('/')), 'utf8')))).join('\n');
for (const token of ['componentsImportOffline', 'importOfflineComponents', 'offline_import_available', '导入离线组件目录']) {
  check(!offlineSurface.includes(token), `Removed offline component import surface remains: ${token}`);
}
for (const relative of ['src/main/component-bundle.ts', 'tests/component-bundle.test.ts', 'docs/offline-components.md']) {
  check(!existsSync(path.join(root, ...relative.split('/'))), `Removed offline component file remains: ${relative}`);
}
check(componentManagerSource.includes("if (consent !== true) throw new Error('COMPONENT_CONSENT_REQUIRED')"), 'Online component setup can start without explicit consent.');
check(componentManagerSource.includes("source.protocol !== 'https:'"), 'Online component downloads are not restricted to HTTPS.');
check(componentManagerSource.includes('net.fetch('), 'Online component downloads do not use Electron system-proxy-aware networking.');
check(componentManagerSource.includes('withDownloadRetries('), 'Online component downloads do not retry transient failures.');
check(componentManagerSource.includes("spawn('curl.exe'"), 'Windows component downloads do not use the resilient system curl transport.');
check(componentManagerSource.includes("spawn('taskkill.exe'"), 'Stalled Windows component downloads do not terminate the process tree.');

const componentCatalog = JSON.parse(await readFile(path.join(root, 'resources', 'components.json'), 'utf8'));
check(
  ['internal-only', 'redistributable'].includes(componentCatalog.tracknet_weight?.redistribution),
  'The TrackNet weight redistribution boundary is missing or invalid.',
);
if (componentCatalog.tracknet_weight?.redistribution === 'internal-only') {
  check(componentCatalog.tracknet_weight?.downloadable === false, 'The internal-only TrackNet weight is incorrectly marked downloadable.');
}
check(/^[a-f0-9]{64}$/.test(componentCatalog.tracknet_weight?.sha256 ?? ''), 'The fixed TrackNet weight hash is missing.');
check(componentCatalog.tracknet_weight?.downloadable === true, 'The managed TrackNet weight is not downloadable.');
check(componentCatalog.tracknet_weight?.url === 'https://github.com/WeiyePlayer/TTcut-runtime-assets/releases/download/tracknet-weight-1.0.0/TrackNet_best.pt', 'The managed TrackNet weight URL is not the fixed production asset.');
check(componentCatalog.tracknet_weight?.size_bytes === 136191005, 'The managed TrackNet weight size is incorrect.');
check(componentCatalog.tracknet_weight?.install_directory === 'models', 'The managed TrackNet weight install directory is incorrect.');
check(/^[a-f0-9]{64}$/.test(componentCatalog.ffmpeg?.sha256 ?? ''), 'The fixed FFmpeg archive hash is missing.');

const publicReleaseCandidate = process.env.TTCUT_PUBLIC_RC === '1';
if (publicReleaseCandidate) {
  check((process.env.TTCUT_PUBLISHER_NAME?.trim() || packageJson.author) === 'weiye', 'Public RC publisher must be weiye.');
  check(Boolean((process.env.WINDOWS_CERTIFICATE_FILE && process.env.WINDOWS_CERTIFICATE_PASSWORD) || process.env.WINDOWS_SIGN_WITH_PARAMS || process.env.WINDOWS_SIGNTOOL_PATH), 'Public RC Authenticode credentials are missing.');
  const runtimeAssets = componentCatalog.analysis_runtime?.assets ?? [];
  check(runtimeAssets.length === 2 && new Set(runtimeAssets.map((asset) => asset.variant)).size === 2, 'Public RC requires immutable CPU and cu126 runtime assets.');
  check(runtimeAssets.every((asset) => Array.isArray(asset.parts) && asset.parts.length > 0 && asset.parts.every((part) => part.url.startsWith('https://') && !part.url.includes('REPLACE-') && /^[a-f0-9]{64}$/.test(part.sha256))), 'Public RC runtime asset part URLs or hashes are not immutable production values.');
  check(componentCatalog.tracknet_weight?.redistribution === 'redistributable', 'Public RC cannot package the internal-only TrackNet weight.');
  const evidence = componentCatalog.tracknet_weight?.rights_evidence;
  if (evidence) {
    const evidencePath = path.join(root, 'resources', ...evidence.path.split('/'));
    check(existsSync(evidencePath), 'TrackNet weight rights evidence file is missing.');
    if (existsSync(evidencePath)) {
      const actual = createHash('sha256').update(await readFile(evidencePath)).digest('hex');
      check(actual === evidence.sha256, 'TrackNet weight rights evidence hash does not match the catalog.');
    }
  } else {
    check(false, 'TrackNet weight rights evidence is missing.');
  }
  check(componentCatalog.tracknet_weight.downloadable === true, 'Public RC TrackNet weight must be a managed download.');
}

const forgeSource = await readFile(path.join(root, 'forge.config.ts'), 'utf8');
for (const fuse of [
  '[FuseV1Options.RunAsNode]: false',
  '[FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false',
  '[FuseV1Options.EnableNodeCliInspectArguments]: false',
  '[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true',
  '[FuseV1Options.OnlyLoadAppFromAsar]: true',
]) {
  check(forgeSource.includes(fuse), `Forge security fuse is missing: ${fuse}`);
}
check(forgeSource.includes("extraResource: ['.runtime/worker'"), 'Forge does not package the staged minimal Worker.');
check(forgeSource.includes("'.runtime/release-metadata'"), 'Forge does not package generated license metadata.');
check(forgeSource.includes("process.env.TTCUT_PUBLIC_RC === '1'"), 'Forge does not enforce the public RC signing mode.');
check(forgeSource.includes('TTCUT_PUBLISHER_NAME'), 'Forge does not require an explicit personal publisher name.');
check(forgeSource.includes('windowsSign'), 'Forge Authenticode integration is missing.');

const releaseMetadata = path.join(root, '.runtime', 'release-metadata');
for (const relative of ['THIRD_PARTY_NOTICES.html', 'THIRD_PARTY_NOTICES.md', 'sbom.cdx.json', 'licenses/index.json', 'licenses/tracknet/LICENSE.txt', 'licenses/tracknet/WEIGHT_RIGHTS.md']) {
  check(existsSync(path.join(releaseMetadata, ...relative.split('/'))), `Generated release metadata is missing ${relative}.`);
}
if (existsSync(path.join(releaseMetadata, 'THIRD_PARTY_NOTICES.html'))) {
  const licenseCenter = await readFile(path.join(releaseMetadata, 'THIRD_PARTY_NOTICES.html'), 'utf8');
  check(licenseCenter.includes('TTcut 第三方许可证'), 'Generated license center is missing its UTF-8 Chinese title.');
  check(licenseCenter.includes('本页列出桌面应用及其受管下载组件的许可证正文'), 'Generated license center contains missing or corrupted user-facing text.');
}
if (existsSync(path.join(releaseMetadata, 'licenses', 'index.json'))) {
  const licenseIndex = JSON.parse(await readFile(path.join(releaseMetadata, 'licenses', 'index.json'), 'utf8'));
  check(Array.isArray(licenseIndex.components) && licenseIndex.components.length >= 9, 'Generated license index is incomplete.');
  check(licenseIndex.components.every((component) => Array.isArray(component.license_files) && component.license_files.length > 0), 'A shipped component has no bundled license body.');
  check(licenseIndex.components.some((component) => component.name === componentCatalog.tracknet_weight.filename), 'Shipped TrackNet weight is missing from the generated license index.');
}

await auditWorker(path.join(root, '.runtime', 'worker'), 'staged Worker');

const packagedRoot = path.join(root, 'out', 'TTcut-win32-x64');
if (existsSync(packagedRoot)) {
  const packagedWorker = path.join(packagedRoot, 'resources', 'worker');
  await auditWorker(packagedWorker, 'packaged Worker');
  const archive = path.join(packagedRoot, 'resources', 'app.asar');
  check(existsSync(path.join(packagedRoot, 'resources', 'resources', 'components.json')), 'Packaged component catalog is missing.');
  check(existsSync(path.join(packagedRoot, 'resources', 'release-metadata', 'THIRD_PARTY_NOTICES.html')), 'Packaged third-party license center is missing.');
  check(existsSync(path.join(packagedRoot, 'resources', 'release-metadata', 'sbom.cdx.json')), 'Packaged SBOM is missing.');
  check(existsSync(path.join(packagedRoot, 'LICENSE')), 'Packaged Electron license is missing.');
  check(existsSync(path.join(packagedRoot, 'LICENSES.chromium.html')), 'Packaged Chromium license collection is missing.');
  const packagedWeight = path.join(packagedRoot, 'resources', 'resources', 'models', 'TrackNet_best.pt');
  const packagedLicenseCenter = path.join(packagedRoot, 'resources', 'release-metadata', 'THIRD_PARTY_NOTICES.html');
  if (existsSync(packagedLicenseCenter)) {
    const licenseCenter = await readFile(packagedLicenseCenter, 'utf8');
    check(licenseCenter.includes('TTcut 第三方许可证'), 'Packaged license center contains corrupted user-facing text.');
  }
  check(!existsSync(packagedWeight), 'Managed TrackNet weight was incorrectly packaged in the installer.');
  check(existsSync(archive), 'Packaged app.asar is missing.');
  if (existsSync(archive)) {
    const entries = listPackage(archive).map((entry) => entry.replaceAll('\\', '/'));
    for (const forbidden of ['/.agents', '/.baseline', '/.codex', '/.learnings', '/.pytest_cache', '/.runtime', '/docs', '/output', '/resources', '/scripts', '/src', '/tests', '/worker']) {
      check(!entries.some((entry) => entry === forbidden || entry.startsWith(`${forbidden}/`)), `app.asar contains development-only path ${forbidden}`);
    }
    for (const required of ['/.vite/build/main.js', '/.vite/build/preload.js', '/.vite/renderer/main_window/index.html']) {
      check(entries.includes(required), `app.asar is missing ${required}`);
    }
  }
}

if (failures.length) {
  console.error(`Release verification failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log('Release verification passed: minimal Worker, production-only E2E gate, secure Renderer, and Forge fuses verified.');
}
