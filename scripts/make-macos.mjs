import path from 'node:path';
import { rename, writeFile, readFile, mkdir, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
process.chdir(root);
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('macOS arm64 build host required');
const run = (command, args) => { const r = spawnSync(command, args, { cwd: root, stdio: 'inherit' }); if (r.status !== 0) throw new Error(`${command} failed (${r.status})`); };
if (!process.argv.includes('--skip-native')) run('python3', ['scripts/stage-macos-runtime.py']);
const { api } = require('@electron-forge/core');
await api.package({ dir: root, platform: 'darwin', arch: 'arm64', interactive: false });
const app = path.join(root, 'out/TTcut-darwin-arm64/TTcut.app');
await rename(path.join(app, 'Contents/Resources/macos'), path.join(app, 'Contents/Resources/runtime'));
const entitlementPath = path.join(root, '.runtime/electron-entitlements.plist');
await writeFile(entitlementPath, '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/></dict></plist>');
const { signAsync } = require('@electron/osx-sign');
await signAsync({ app, identity: '-', identityValidation: false, platform: 'darwin', preAutoEntitlements: false, preEmbedProvisioningProfile: false,
  ignore: (file) => file.startsWith(path.join(app, 'Contents/Resources/runtime')),
  optionsForFile: () => ({ hardenedRuntime: false, entitlements: entitlementPath, timestamp: 'none' }),
});
run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
if (!process.argv.includes('--app-only')) run(process.execPath, [require.resolve('electron-builder/out/cli/cli.js'), '--mac', 'dmg', 'zip', '--arm64', '--prepackaged', app, '--config', 'electron-builder.macos.cjs', '--publish', 'never']);
const output = path.join(root, 'out/make/macos/arm64'); await mkdir(output, { recursive: true });
const version = require('../package.json').version;
const releaseArchives = new Set([
 `TTcut-${version}-macOS-arm64-electron.dmg`,
 `TTcut-${version}-macOS-arm64-electron.zip`,
]);
const files = [];
for (const name of await readdir(output)) {
 if (!releaseArchives.has(name)) continue;
 const file = path.join(output, name); const bytes = await readFile(file);
 files.push({ file: name, bytes: (await stat(file)).size, sha256: createHash('sha256').update(bytes).digest('hex') });
}
const git = (args) => spawnSync('git', args, { encoding: 'utf8', cwd: root }).stdout.trim();
const report = { app, version, build: `electron-local-${new Date().toISOString().replace(/[-:.TZ]/g, '')}`, sourceCommit: git(['rev-parse', 'HEAD']), sourceDirty: Boolean(git(['status', '--porcelain', '--untracked-files=no'])), untrackedFiles: git(['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean), signature: 'ad-hoc', notarized: false, updater: 'disabled', files };
await writeFile(path.join(output, 'build-manifest.json'), JSON.stringify(report, null, 2) + '\n');
await writeFile(path.join(output, 'SHA256SUMS'), files.map((f) => `${f.sha256}  ${f.file}`).join('\n') + '\n');
console.log(JSON.stringify(report, null, 2));
