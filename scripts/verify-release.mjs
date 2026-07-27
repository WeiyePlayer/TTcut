import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { listPackage } = require('@electron/asar');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

async function sha256(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
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
  for (const name of ['requirements-cpu.txt', 'requirements-cu126.txt', 'requirements-cu132.txt', 'runtime-wheel-lock.json', 'SOURCE_MANIFEST.md', 'LICENSE.tracknet.txt']) {
    check(relative.includes(name), `${label} is missing ${name}`);
  }
  for (const name of ['ttcut_worker/table_analyze.py', 'ttcut_worker/table_model.py']) {
    check(relative.includes(name), `${label} is missing automatic table analysis source: ${name}`);
  }
  check(!relative.some((name) => /(^|\/)vendor(\/|$)/i.test(name)), `${label} contains a vendored training/source tree.`);
  for (const requirement of ['requirements-cpu.txt', 'requirements-cu126.txt', 'requirements-cu132.txt']) {
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
  for (const required of ['numpy:2.5.1', 'opencv-python:4.13.0.92', 'torch:2.12.1+cpu', 'torch:2.12.1+cu126', 'torch:2.12.1+cu132', 'filelock:3.30.3', 'fsspec:2026.6.0', 'jinja2:3.1.6', 'markupsafe:3.0.3', 'mpmath:1.3.0', 'networkx:3.6.1', 'setuptools:81.0.0', 'sympy:1.14.0', 'typing-extensions:4.16.0']) {
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
check(componentsSource.includes('resolveInstallationLayout().componentRoot'), 'Managed components do not resolve from the selected installation root.');
const layoutSource = await readFile(path.join(root, 'src', 'main', 'installation-layout.ts'), 'utf8');
check(layoutSource.includes("path.join(resolvedRoot, 'app')"), 'Installation layout does not define <root>\\app.');
check(layoutSource.includes("path.join(resolvedRoot, 'data', 'components')"), 'Installation layout does not define <root>\\data\\components.');
check(layoutSource.includes('INSTALL_ROOT_REGISTRY_MISSING'), 'Packaged layout does not require the registered installation root.');
check(layoutSource.includes('INSTALL_ROOT_REGISTRY_MISMATCH'), 'Packaged layout does not cross-check the executable path and registry root.');
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
const modelManifest = JSON.parse(await readFile(path.join(root, 'resources', 'model-manifest.json'), 'utf8'));
check(modelManifest.schema_version === 1, 'The bundled model manifest schema is invalid.');
check(modelManifest.models?.length === 2, 'The bundled model manifest must contain exactly two models.');
check(new Set(modelManifest.models?.map((model) => model.filename)).size === 2, 'The bundled model manifest contains duplicate filenames.');
for (const [filename, size, hash] of [
  ['analyze.pt', 136191005, 'ffb5469161c4bd39a5a7e745c3d13f076b2c5e575f33279ea62f1e5803245a52'],
  ['table_analyze.pt', 99028986, '160e1a9b2d0236b501dc4a4d38bbfb39315eeef6de5d8c11770452623ff102df'],
]) {
  const model = modelManifest.models?.find((candidate) => candidate.filename === filename);
  check(model?.size_bytes === size && model?.sha256 === hash, `Bundled model manifest entry is invalid: ${filename}`);
}
check(!('tracknet_weight' in componentCatalog), 'Model weights remain in the managed component catalog.');
check(!('table_weight' in componentCatalog), 'Table model weights remain in the managed component catalog.');
check(/^[a-f0-9]{64}$/.test(componentCatalog.ffmpeg?.sha256 ?? ''), 'The fixed FFmpeg archive hash is missing.');
check(componentCatalog.ffmpeg_x264?.asset === 'ffmpeg-N-125716-g1b1f602699-win64-gpl.zip', 'The fixed x264 asset name is incorrect.');
check(componentCatalog.ffmpeg_x264?.size_bytes === 168733210, 'The fixed x264 asset size is incorrect.');
check(componentCatalog.ffmpeg_x264?.sha256 === '6dcf685c2fea98221b3f179961165e9c31f55bead576c4479ae4549858fbf826', 'The fixed x264 asset hash is incorrect.');
check(componentCatalog.ffmpeg_x264?.required_build_flags?.includes('--enable-libx264'), 'The x264 encoder build requirement is missing.');
check(componentCatalog.ffmpeg_x264?.required_encoders?.includes('libx264'), 'The x264 encoder requirement is missing.');
check(
  componentCatalog.analysis_runtime?.assets?.every((asset) => Number.isSafeInteger(asset.installed_size_bytes) && asset.installed_size_bytes > 0),
  'An analysis runtime is missing installed_size_bytes.',
);
check(Number.isSafeInteger(componentCatalog.ffmpeg?.installed_size_bytes) && componentCatalog.ffmpeg.installed_size_bytes > 0, 'FFmpeg is missing installed_size_bytes.');
check(Number.isSafeInteger(componentCatalog.ffmpeg_x264?.installed_size_bytes) && componentCatalog.ffmpeg_x264.installed_size_bytes > 0, 'FFmpeg x264 is missing installed_size_bytes.');

const publicReleaseCandidate = process.env.TTCUT_PUBLIC_RC === '1';
const officialRelease = process.env.TTCUT_OFFICIAL_RELEASE === '1';
const releaseSigningRequired = publicReleaseCandidate || officialRelease;
if (releaseSigningRequired) {
  check((process.env.TTCUT_PUBLISHER_NAME?.trim() || packageJson.author) === 'weiye', 'Public release publisher must be weiye.');
  check(Boolean((process.env.WINDOWS_CERTIFICATE_FILE && process.env.WINDOWS_CERTIFICATE_PASSWORD) || process.env.WINDOWS_CERTIFICATE_THUMBPRINT || process.env.WINDOWS_SIGN_WITH_PARAMS), 'Public release Authenticode credentials are missing.');
  if (officialRelease) {
    check(/^[A-Fa-f0-9]{40,64}$/.test(process.env.WINDOWS_CERTIFICATE_THUMBPRINT ?? ''), 'Official release certificate thumbprint is missing or invalid.');
    check(Boolean(process.env.WINDOWS_SIGNTOOL_PATH), 'Official release Windows SDK SignTool path is missing.');
  }
  const runtimeAssets = componentCatalog.analysis_runtime?.assets ?? [];
  check(runtimeAssets.length === 3 && new Set(runtimeAssets.map((asset) => asset.variant)).size === 3, 'Public RC requires immutable CPU, cu126, and cu132 runtime assets.');
  check(runtimeAssets.every((asset) => Array.isArray(asset.parts) && asset.parts.length > 0 && asset.parts.every((part) => part.url.startsWith('https://') && !part.url.includes('REPLACE-') && /^[a-f0-9]{64}$/.test(part.sha256))), 'Public RC runtime asset part URLs or hashes are not immutable production values.');
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
check(forgeSource.includes("process.env.TTCUT_PUBLIC_RC === '1'"), 'Forge does not retain the public RC signing mode.');
check(forgeSource.includes("process.env.TTCUT_OFFICIAL_RELEASE === '1'"), 'Forge does not enforce the official release signing mode.');
check(forgeSource.includes('WINDOWS_CERTIFICATE_THUMBPRINT'), 'Forge does not pin the official signer certificate thumbprint.');
check(forgeSource.includes('TTCUT_PUBLISHER_NAME'), 'Forge does not require an explicit personal publisher name.');
check(forgeSource.includes('windowsSign'), 'Forge Authenticode integration is missing.');
check(forgeSource.includes('electron-v43.1.1-win32-x64.zip'), 'Pinned Electron Windows archive name is missing.');
check(forgeSource.includes('b4e9995cd3f65785eb8818276aa9020f3165ab11da41b3c762616d4a0ad8c7ad'), 'Pinned Electron Windows archive checksum is missing.');

const builderSource = await readFile(path.join(root, 'electron-builder.config.cjs'), 'utf8');
check(packageJson.devDependencies?.['electron-builder'] === '26.15.3', 'electron-builder is not pinned to 26.15.3.');
check(packageJson.devDependencies?.['electron-updater'] === '6.8.9', 'electron-updater is not pinned to 6.8.9.');
check(!forgeSource.includes('MakerSquirrel'), 'The active Forge configuration still contains MakerSquirrel.');
check(builderSource.includes("target: 'nsis'"), 'The active installer target is not NSIS.');
check(builderSource.includes('oneClick: false'), 'The NSIS installer is not assisted mode.');
check(builderSource.includes('perMachine: false'), 'The NSIS installer is not current-user mode.');
check(builderSource.includes("include: 'build/installer/installer.nsh'"), 'The branded NSIS include is missing.');

const releaseMetadata = path.join(root, '.runtime', 'release-metadata');
for (const relative of ['THIRD_PARTY_NOTICES.html', 'THIRD_PARTY_NOTICES.md', 'sbom.cdx.json', 'licenses/index.json', 'licenses/tracknet/LICENSE.txt']) {
  check(existsSync(path.join(releaseMetadata, ...relative.split('/'))), `Generated release metadata is missing ${relative}.`);
}
if (existsSync(path.join(releaseMetadata, 'THIRD_PARTY_NOTICES.html'))) {
  const licenseCenter = await readFile(path.join(releaseMetadata, 'THIRD_PARTY_NOTICES.html'), 'utf8');
  check(licenseCenter.includes('TTcut 第三方许可证'), 'Generated license center is missing its UTF-8 Chinese title.');
  check(licenseCenter.includes('本页列出桌面应用、随安装器分发的模型资源及受管下载组件的许可证材料'), 'Generated license center contains missing or corrupted user-facing text.');
}
if (existsSync(path.join(releaseMetadata, 'licenses', 'index.json'))) {
  const licenseIndex = JSON.parse(await readFile(path.join(releaseMetadata, 'licenses', 'index.json'), 'utf8'));
  check(Array.isArray(licenseIndex.components) && licenseIndex.components.length >= 9, 'Generated license index is incomplete.');
  check(licenseIndex.components.every((component) => Array.isArray(component.license_files) && component.license_files.length > 0), 'A shipped component has no bundled license body.');
  for (const model of modelManifest.models) {
    check(licenseIndex.components.some((component) => component.name === model.filename), `Bundled model is missing from the generated license index: ${model.filename}`);
  }
  check(licenseIndex.components.some((component) => component.name === 'FFmpeg libx264 optional media component'), 'Optional x264 component is missing from the generated license index.');
}

await auditWorker(path.join(root, '.runtime', 'worker'), 'staged Worker');

const packagedRoot = path.join(root, 'out', 'TTcut-win32-x64');
if (existsSync(packagedRoot)) {
  const packagedWorker = path.join(packagedRoot, 'resources', 'worker');
  await auditWorker(packagedWorker, 'packaged Worker');
  const archive = path.join(packagedRoot, 'resources', 'app.asar');
  const updaterConfig = path.join(packagedRoot, 'resources', 'app-update.yml');
  check(existsSync(updaterConfig), 'Packaged electron-updater configuration is missing.');
  if (existsSync(updaterConfig)) {
    const updaterConfigSource = await readFile(updaterConfig, 'utf8');
    check(updaterConfigSource.includes('provider: github'), 'Packaged updater provider is not GitHub.');
    check(updaterConfigSource.includes(packageJson.version.includes('-beta') ? 'channel: beta' : 'channel: latest'), 'Packaged updater channel does not match the application version.');
    check(updaterConfigSource.includes('publisherName: weiye'), 'Packaged updater publisher is not weiye.');
  }
  check(existsSync(path.join(packagedRoot, 'resources', 'resources', 'components.json')), 'Packaged component catalog is missing.');
  check(existsSync(path.join(packagedRoot, 'resources', 'release-metadata', 'THIRD_PARTY_NOTICES.html')), 'Packaged third-party license center is missing.');
  check(existsSync(path.join(packagedRoot, 'resources', 'release-metadata', 'sbom.cdx.json')), 'Packaged SBOM is missing.');
  check(existsSync(path.join(packagedRoot, 'LICENSE')), 'Packaged Electron license is missing.');
  check(existsSync(path.join(packagedRoot, 'LICENSES.chromium.html')), 'Packaged Chromium license collection is missing.');
  const packagedModels = path.join(packagedRoot, 'resources', 'resources', 'models');
  const packagedLicenseCenter = path.join(packagedRoot, 'resources', 'release-metadata', 'THIRD_PARTY_NOTICES.html');
  if (existsSync(packagedLicenseCenter)) {
    const licenseCenter = await readFile(packagedLicenseCenter, 'utf8');
    check(licenseCenter.includes('TTcut 第三方许可证'), 'Packaged license center contains corrupted user-facing text.');
  }
  check(existsSync(path.join(packagedRoot, 'resources', 'resources', 'model-manifest.json')), 'Packaged model manifest is missing.');
  if (existsSync(packagedModels)) {
    const modelFiles = (await readdir(packagedModels)).filter((name) => /\.pt$/i.test(name)).sort();
    check(JSON.stringify(modelFiles) === JSON.stringify(['analyze.pt', 'table_analyze.pt']), `Packaged model names are incorrect: ${modelFiles.join(', ')}`);
    for (const model of modelManifest.models) {
      const modelPath = path.join(packagedModels, model.filename);
      if (!existsSync(modelPath)) {
        check(false, `Packaged model is missing: ${model.filename}`);
        continue;
      }
      check((await stat(modelPath)).size === model.size_bytes, `Packaged model size is incorrect: ${model.filename}`);
      check(await sha256(modelPath) === model.sha256, `Packaged model hash is incorrect: ${model.filename}`);
    }
  } else {
    check(false, 'Packaged model directory is missing.');
  }
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

const nsisRoot = path.join(root, 'out', 'make', 'nsis', 'x64');
if (existsSync(nsisRoot)) {
  const artifacts = await readdir(nsisRoot);
  const setup = artifacts.find((name) => /-Setup\.exe$/i.test(name));
  check(Boolean(setup), 'The NSIS Setup artifact is missing.');
  check(Boolean(setup && artifacts.includes(`${setup}.blockmap`)), 'The NSIS blockmap is missing.');
  check(artifacts.some((name) => /^(latest|beta)\.yml$/i.test(name)), 'NSIS update metadata is missing.');
  check(!artifacts.some((name) => /\.nupkg$/i.test(name) || name === 'RELEASES'), 'A Squirrel artifact remains in the active NSIS output.');
}

if (failures.length) {
  console.error(`Release verification failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log('Release verification passed: packaged app, assisted NSIS contract, installation layout, component catalog, and Forge fuses verified.');
}
