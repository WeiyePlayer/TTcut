// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const state = vi.hoisted(() => ({ root: '' }));
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => state.root } }));
let runtime: typeof import('../src/main/macos/runtime');
let manifest: { schema_version: number; architecture: string; minimum_os: string; files: { path: string; bytes: number; sha256: string }[] };
beforeEach(async () => {
  vi.resetModules(); state.root = await mkdtemp(path.join(tmpdir(),'ttcut-runtime-test-'));
  const required = ['bin/TTcutWorker','bin/TTcutMediaWorker','bin/ffmpeg','bin/ffprobe','Models/BlurBall.mlmodelc/weights/weight.bin','Models/Table.mlmodelc/weights/weight.bin'];
  manifest = { schema_version: 1, architecture: 'arm64', minimum_os: '15.0', files: [] };
  for (const name of required) {
    const file = path.join(state.root,'.runtime/macos',name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,'fixture',{mode:0o755});
    manifest.files.push({ path:name, bytes:7, sha256:createHash('sha256').update('fixture').digest('hex') });
  }
  runtime = await import('../src/main/macos/runtime');
});
afterEach(async () => { await rm(state.root,{recursive:true,force:true}); });
async function saveManifest() { await writeFile(path.join(state.root,'.runtime/macos/manifest.json'),JSON.stringify(manifest)); }
it('reports a damaged model and allows a repaired runtime to be checked again',async()=>{
  await saveManifest(); const weight=path.join(state.root,'.runtime/macos/Models/Table.mlmodelc/weights/weight.bin');await writeFile(weight,'changed');
  expect((await runtime.inspectMacComponents()).analysis).toMatchObject({available:false,detail:expect.stringContaining('BUNDLED_RESOURCE_CORRUPT')});
  await writeFile(weight,'fixture');expect((await runtime.inspectMacComponents()).analysis.available).toBe(true);
});
it('rejects incomplete and path-escaping manifests',async()=>{
  const removed=manifest.files.pop()!;await saveManifest();await expect(runtime.verifyMacRuntime()).rejects.toThrow('BUNDLED_RUNTIME_MANIFEST_INVALID');
  manifest.files.push(removed,{...removed,path:'../outside'});await saveManifest();await expect(runtime.verifyMacRuntime()).rejects.toThrow('BUNDLED_RUNTIME_MANIFEST_INVALID');
});
it('rejects a missing executable before launching work',async()=>{
  await saveManifest();await rm(path.join(state.root,'.runtime/macos/bin/ffprobe'));expect((await runtime.inspectMacComponents()).media.available).toBe(false);
});
