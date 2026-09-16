import path from 'node:path';
import { copyFile, cp, lstat, mkdir, readFile, readdir, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const stage = path.join(root, '.runtime', 'tracknet-local');
const workerStage = path.join(root, '.runtime', 'worker');
const defaultPython = '/Users/weiye/TTcut-ios/tools/model-conversion/.venv';
const defaultDependencies = '/tmp/ttcut-tracknet-deps';
const defaultWeight = '/Users/weiye/Documents/TrackNet_best.pt';
const defaultTableWeight = '/Users/weiye/DOS/TTcut-windows/TTcut/resources/models/table_analyze.pt';
const defaultMacRuntime = '/Users/weiye/DOS/TTcut-windows/TTcut/.runtime/macos';
const defaultPythonFramework = '/opt/homebrew/Cellar/python@3.11/3.11.16/Frameworks/Python.framework';

const value = (name, fallback) => process.env[name]?.trim() || fallback;
const python = path.resolve(value('TTCUT_TRACKNET_PYTHON_ENV', defaultPython));
const dependencies = path.resolve(value('TTCUT_TRACKNET_PYTHON_DEPS', defaultDependencies));
const weight = path.resolve(value('TTCUT_TRACKNET_WEIGHTS', defaultWeight));
const tableWeight = path.resolve(value('TTCUT_TABLE_ANALYZE_WEIGHTS', defaultTableWeight));
const macRuntime = path.resolve(value('TTCUT_MAC_RUNTIME', defaultMacRuntime));
const pythonFramework = path.resolve(value('TTCUT_PYTHON_FRAMEWORK', defaultPythonFramework));
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.status !== 0) throw new Error(`${command} failed (${String(result.status)})`);
};
const requireFile = async (file) => {
  if (!(await stat(file).catch(() => null))?.isFile()) throw new Error(`Required file is missing: ${file}`);
};
const requireDirectory = async (directory) => {
  if (!(await stat(directory).catch(() => null))?.isDirectory()) throw new Error(`Required directory is missing: ${directory}`);
};
const sha256 = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');

if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('macOS arm64 build host required');
await Promise.all([
  requireDirectory(python), requireDirectory(dependencies), requireDirectory(macRuntime), requireDirectory(pythonFramework),
  requireFile(weight), requireFile(tableWeight), requireFile(path.join(macRuntime, 'manifest.json')),
]);
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await cp(python, stage, { recursive: true, filter: (entry) => !entry.includes('__pycache__') && !entry.endsWith('.pyc') });
const sitePackages = path.join(stage, 'lib', 'python3.11', 'site-packages');
for (const name of ['python', 'python3', 'python3.11']) await rm(path.join(stage, 'bin', name), { force: true });
run('/bin/cp', ['-a', pythonFramework, path.join(stage, 'python-base')]);
const frameworkExecutable = path.join(stage, 'bin', 'python-base-exec');
const frameworkLibrary = path.join(stage, 'python-base', 'Versions', '3.11', 'Python');
const pythonAppExecutable = path.join(stage, 'python-base', 'Versions', '3.11', 'Resources', 'Python.app', 'Contents', 'MacOS', 'Python');
await copyFile(path.join(python, 'bin', 'python3.11'), frameworkExecutable);
await rm(path.join(stage, 'python-base', 'Versions', '3.11', 'bin'), { recursive: true, force: true });
await rm(path.join(stage, 'python-base', 'Versions', '3.11', 'lib', 'python3.11', 'site-packages'), { force: true });
run('install_name_tool', ['-change',
  '/opt/homebrew/Cellar/python@3.11/3.11.16/Frameworks/Python.framework/Versions/3.11/Python',
  '@executable_path/../python-base/Versions/3.11/Python', frameworkExecutable]);
run('install_name_tool', ['-change',
  '/opt/homebrew/Cellar/python@3.11/3.11.16/Frameworks/Python.framework/Versions/3.11/Python',
  '@executable_path/../../../../Python', pythonAppExecutable]);
run('install_name_tool', ['-delete_rpath', '/opt/homebrew/lib', pythonAppExecutable]);
run('install_name_tool', ['-id', '@rpath/Python.framework/Versions/3.11/Python', frameworkLibrary]);
run('install_name_tool', ['-delete_rpath', '/opt/homebrew/lib', frameworkLibrary]);
const dynamicDirectory = path.join(stage, 'python-base', 'Versions', '3.11', 'lib', 'python3.11', 'lib-dynload');
const vendorDirectory = path.join(stage, 'python-base', 'Versions', '3.11', 'lib', 'vendor');
await mkdir(vendorDirectory, { recursive: true });
const vendorLibraries = [
  ['libsqlite3.dylib', '/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib'],
  ['liblzma.5.dylib', '/opt/homebrew/opt/xz/lib/liblzma.5.dylib'],
  ['libmpdec.4.dylib', '/opt/homebrew/opt/mpdecimal/lib/libmpdec.4.dylib'],
  ['libcrypto.3.dylib', '/opt/homebrew/opt/openssl@3/lib/libcrypto.3.dylib'],
  ['libssl.3.dylib', '/opt/homebrew/opt/openssl@3/lib/libssl.3.dylib'],
];
for (const [name, source] of vendorLibraries) {
  const destination = path.join(vendorDirectory, name);
  await copyFile(source, destination);
  run('install_name_tool', ['-id', name, destination]);
}
for (const [module, dependencies] of Object.entries({
  '_sqlite3.cpython-311-darwin.so': [['/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib', 'libsqlite3.dylib']],
  '_lzma.cpython-311-darwin.so': [['/opt/homebrew/opt/xz/lib/liblzma.5.dylib', 'liblzma.5.dylib']],
  '_decimal.cpython-311-darwin.so': [['/opt/homebrew/opt/mpdecimal/lib/libmpdec.4.dylib', 'libmpdec.4.dylib']],
  '_hashlib.cpython-311-darwin.so': [['/opt/homebrew/opt/openssl@3/lib/libcrypto.3.dylib', 'libcrypto.3.dylib']],
  '_ssl.cpython-311-darwin.so': [
    ['/opt/homebrew/opt/openssl@3/lib/libssl.3.dylib', 'libssl.3.dylib'],
    ['/opt/homebrew/opt/openssl@3/lib/libcrypto.3.dylib', 'libcrypto.3.dylib'],
  ],
})) {
  for (const [source, name] of dependencies) {
    run('install_name_tool', ['-change', source, `@loader_path/../../vendor/${name}`, path.join(dynamicDirectory, module)]);
  }
}
run('install_name_tool', ['-change', '/opt/homebrew/Cellar/openssl@3/3.6.3/lib/libcrypto.3.dylib',
  '@loader_path/libcrypto.3.dylib', path.join(vendorDirectory, 'libssl.3.dylib')]);
run('install_name_tool', ['-delete_rpath', '/opt/homebrew/Cellar/sqlite/3.53.4/lib',
  path.join(vendorDirectory, 'libsqlite3.dylib')]);
run('install_name_tool', ['-id', 'libomp.dylib', path.join(sitePackages, 'torch', 'lib', 'libomp.dylib')]);
run('install_name_tool', ['-delete_rpath', '/Users/runner/work/_temp/anaconda/envs/wheel_py311/lib',
  path.join(sitePackages, 'torch', '_C.cpython-311-darwin.so')]);
await writeFile(path.join(stage, 'bin', 'python'), [
  '#!/bin/sh',
  'runtime_root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"',
  'export PYTHONHOME="$runtime_root/python-base/Versions/3.11"',
  'export PYTHONPATH="$runtime_root/lib/python3.11/site-packages${PYTHONPATH:+:$PYTHONPATH}"',
  'exec "$runtime_root/bin/python-base-exec" "$@"',
  '',
].join('\n'), { mode: 0o755 });
await symlink('python', path.join(stage, 'bin', 'python3'));
await symlink('python', path.join(stage, 'bin', 'python3.11'));
for (const name of await readdir(dependencies)) {
  if (name === 'bin' || name === '__pycache__') continue;
  await cp(path.join(dependencies, name), path.join(sitePackages, name), { recursive: true, force: true });
}
await cp(weight, path.join(stage, 'TrackNet_best.pt'));
await cp(tableWeight, path.join(stage, 'table_analyze.pt'));
await writeFile(path.join(stage, 'manifest.json'), JSON.stringify({
  schema_version: 1,
  purpose: 'local-tracknet-test-only',
  architecture: 'arm64',
  confidence_threshold: 0.36,
  roi_model_scale: 1.0,
  tracknet_sha256: await sha256(weight),
  table_sha256: await sha256(tableWeight),
}, null, 2) + '\n');

run(process.execPath, ['scripts/stage-worker.mjs']);
await rm(path.join(root, '.runtime', 'macos'), { recursive: true, force: true });
await cp(macRuntime, path.join(root, '.runtime', 'macos'), { recursive: true });
const sourceLibraries = path.join(macRuntime, 'lib');
const stagedLibraries = path.join(root, '.runtime', 'macos', 'lib');
for (const name of await readdir(sourceLibraries)) {
  const source = path.join(sourceLibraries, name);
  if (!(await lstat(source)).isSymbolicLink()) continue;
  const destination = path.join(stagedLibraries, name);
  await rm(destination, { force: true });
  await symlink(await readlink(source), destination);
}
run(process.execPath, ['scripts/make-macos.mjs', '--app-only', '--skip-native'], {
  env: { ...process.env, TTCUT_LOCAL_TRACKNET_PACKAGE: '1' },
});
const app = path.join(root, 'out', 'TTcut-darwin-arm64', 'TTcut.app');
await requireFile(path.join(app, 'Contents', 'Resources', 'tracknet-local', 'TrackNet_best.pt'));
await requireFile(path.join(app, 'Contents', 'Resources', 'worker', 'ttcut_worker', 'tracknet_motion.py'));
await writeFile(path.join(root, 'out', 'tracknet-local-build.json'), JSON.stringify({
  app,
  purpose: 'local-tracknet-test-only',
  installer_created: false,
  source_commit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(),
  source_dirty: Boolean(spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout.trim()),
  tracknet_sha256: await sha256(path.join(app, 'Contents', 'Resources', 'tracknet-local', 'TrackNet_best.pt')),
}, null, 2) + '\n');
console.log(`TrackNet local test package: ${app}`);
