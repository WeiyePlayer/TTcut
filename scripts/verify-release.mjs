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

function check(condition, message) { if (!condition) failures.push(message); }
async function sha256(file) { return createHash('sha256').update(await readFile(file)).digest('hex'); }
async function walk(directory) {
  if (!existsSync(directory)) return [];
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walk(absolute));
    else result.push(absolute);
  }
  return result;
}

async function auditModels(resourceRoot, label, manifest) {
  const modelRoot = path.join(resourceRoot, 'models');
  check(existsSync(modelRoot), `${label} model directory is missing.`);
  if (!existsSync(modelRoot)) return;
  const names = (await readdir(modelRoot)).sort();
  const expected = manifest.models.map((model) => model.filename).sort();
  check(JSON.stringify(names) === JSON.stringify(expected), `${label} model set is incorrect: ${names.join(', ')}`);
  for (const model of manifest.models) {
    const file = path.join(modelRoot, model.filename);
    check(model.filename.endsWith('.onnx'), `${label} contains a non-ONNX model: ${model.filename}`);
    if (!existsSync(file)) continue;
    check((await stat(file)).size === model.size_bytes, `${label}/${model.filename} size mismatch.`);
    check(await sha256(file) === model.sha256, `${label}/${model.filename} hash mismatch.`);
  }
  check(!names.some((name) => /\.(pt|pth)$/i.test(name)), `${label} contains a PyTorch checkpoint.`);
}

async function auditWorker(directory, label) {
  check(existsSync(directory), `${label} is missing.`);
  const files = await walk(directory);
  const relative = files.map((file) => path.relative(directory, file).replaceAll('\\', '/'));
  const forbidden = relative.filter((name) => (
    /(^|\/)(tests?|__pycache__)(\/|$)/i.test(name)
    || /\.(pyc|pt)$/i.test(name)
    || /(^|\/)tracknet_|(blurball_models?|table_model|device)\.py$/i.test(name)
  ));
  check(forbidden.length === 0, `${label} contains development/PyTorch files: ${forbidden.join(', ')}`);
  const source = (await Promise.all(files.filter((file) => file.endsWith('.py')).map((file) => readFile(file, 'utf8')))).join('\n');
  check(!/^\s*(?:import torch|from torch)/m.test(source), `${label} imports Torch.`);
  check(relative.includes('requirements-onnx.txt'), `${label} is missing requirements-onnx.txt.`);
  for (const required of ['ttcut_worker/onnx_models.py', 'ttcut_worker/blurball_predictor.py', 'ttcut_worker/table_analyze.py']) {
    check(relative.includes(required), `${label} is missing ${required}.`);
  }
}

async function auditRuntime(directory, label) {
  check(existsSync(directory), `${label} is missing.`);
  const required = [
    'python/python.exe', 'ffmpeg/ffmpeg.exe', 'ffmpeg/ffprobe.exe', 'runtime-manifest.json',
  ];
  for (const name of required) check(existsSync(path.join(directory, ...name.split('/'))), `${label} is missing ${name}.`);
  const files = (await walk(directory)).map((file) => path.relative(directory, file).replaceAll('\\', '/'));
  const forbidden = files.filter((name) => /cuda|torch|torchgen|functorch|triton|\.pt$/i.test(name));
  check(forbidden.length === 0, `${label} contains Torch/CUDA artifacts: ${forbidden.slice(0, 20).join(', ')}`);
  if (existsSync(path.join(directory, 'runtime-manifest.json'))) {
    const value = JSON.parse(await readFile(path.join(directory, 'runtime-manifest.json'), 'utf8'));
    check(value.python === '3.12.13', `${label} has the wrong Python version.`);
    check(value.numpy === '2.5.1', `${label} has the wrong NumPy version.`);
    check(value.opencv === '4.13.0', `${label} has the wrong OpenCV version.`);
    check(value.onnxruntime === '1.24.3', `${label} has the wrong ONNX Runtime version.`);
    check(value.media_encoder === 'libx264', `${label} is not x264-only.`);
    check(value.providers?.includes('CPUExecutionProvider'), `${label} has no CPU provider.`);
    check(value.providers?.includes('DmlExecutionProvider'), `${label} has no DirectML provider.`);
  }
}

const manifest = JSON.parse(await readFile(path.join(root, 'resources', 'model-manifest.json'), 'utf8'));
check(manifest.schema_version === 2 && manifest.opset === 20, 'Model manifest must be schema v2/opset 20.');
check(JSON.stringify(manifest.models.map((model) => model.filename).sort()) === JSON.stringify(['blurball_best.onnx', 'table_analyze.onnx']), 'Model manifest must contain exactly the two production ONNX files.');

for (const removed of [
  'src/main/component-manager.ts', 'src/main/component-import.ts', 'src/main/component-catalog.ts',
  'src/main/installer-migration.ts', 'resources/online-model-delivery.json',
  'scripts/stage-online-installer-resources.mjs', 'build/installer/download-models.ps1',
]) check(!existsSync(path.join(root, ...removed.split('/'))), `Removed component/download surface remains: ${removed}`);

const surface = (await Promise.all([
  'src/main/index.ts', 'src/preload/index.ts', 'src/renderer/App.tsx', 'src/shared/api.ts', 'src/shared/ipc.ts',
].map((name) => readFile(path.join(root, ...name.split('/')), 'utf8')))).join('\n');
for (const token of ['component:install', 'component:import', 'component:open-download', 'TTCUT_ONLINE_MODEL_INSTALLER']) {
  check(!surface.includes(token), `Removed component operation remains: ${token}`);
}

await auditModels(path.join(root, '.runtime', 'resources'), 'staged resources', manifest);
await auditWorker(path.join(root, '.runtime', 'worker'), 'staged Worker');
await auditRuntime(path.join(root, '.runtime', 'windows'), 'staged Windows runtime');

const packageRoot = path.join(root, 'out', 'TTcut-win32-x64');
if (existsSync(packageRoot)) {
  const resources = path.join(packageRoot, 'resources');
  await auditModels(path.join(resources, 'resources'), 'packaged resources', manifest);
  await auditWorker(path.join(resources, 'worker'), 'packaged Worker');
  await auditRuntime(path.join(resources, 'windows'), 'packaged Windows runtime');
  const allFiles = (await walk(resources)).map((file) => path.relative(resources, file).replaceAll('\\', '/'));
  const forbidden = allFiles.filter((name) => /cuda|torch|torchgen|functorch|triton|\.pt$/i.test(name) || /openh264|online-model|download-model/i.test(name));
  check(forbidden.length === 0, `Packaged resources contain forbidden runtime/download files: ${forbidden.slice(0, 20).join(', ')}`);

  const archive = path.join(resources, 'app.asar');
  check(existsSync(archive), 'Packaged app.asar is missing.');
  if (existsSync(archive)) {
    const entries = listPackage(archive).map((entry) => entry.replaceAll('\\', '/'));
    for (const required of ['/.vite/build/main.js', '/.vite/build/preload.js', '/.vite/renderer/main_window/index.html']) {
      check(entries.includes(required), `app.asar is missing ${required}.`);
    }
  }
}

const nsisRoot = path.join(root, 'out', 'make', 'nsis', 'x64');
if (existsSync(nsisRoot)) {
  const artifacts = await readdir(nsisRoot);
  const setup = artifacts.find((name) => /-Setup\.exe$/i.test(name));
  check(Boolean(setup), 'NSIS Setup is missing.');
  check(Boolean(setup && artifacts.includes(`${setup}.blockmap`)), 'NSIS blockmap is missing.');
  check(!artifacts.some((name) => /Online-Setup/i.test(name)), 'Legacy online Setup remains.');
}

if (failures.length) {
  console.error(`Release verification failed (${failures.length}):`);
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exitCode = 1;
} else {
  console.log('Release verification passed: ONNX models, minimal Worker, bundled DirectML/CPU runtime, and x264-only package contract verified.');
}
