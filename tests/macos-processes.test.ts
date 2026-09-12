// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { beginTrackedTask, cancelTask, endTrackedTask, hasActiveTasks, spawnTracked, cancelAllTasksAndWait, trackBackgroundProcess, hasBackgroundProcesses } from '../src/main/processes';
describe.skipIf(process.platform !== 'darwin')('macOS process groups', () => {
  it('waits for a background probe group even when its parent exits first', async () => {
    const { spawn, execFileSync } = await import('node:child_process');
    const child = spawn(process.execPath, ['-e', `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','ignore']});child.stdout.once('data',()=>console.log(child.pid));setInterval(()=>{},1000);`], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    trackBackgroundProcess(child);
    const [data] = await once(child.stdout, 'data'); const descendant = Number(data.toString().trim());
    expect(hasBackgroundProcesses()).toBe(true);
    await cancelAllTasksAndWait();
    expect(hasBackgroundProcesses()).toBe(false);
    const state = (() => { try { return execFileSync('/bin/ps', ['-o','state=','-p',String(descendant)], {encoding:'utf8'}).trim(); } catch { return ''; } })();
    expect(state === '' || state.startsWith('Z')).toBe(true);
  }, 10000);
  it('kills a SIGTERM-resistant child and its descendant, and waits for cleanup', async () => {
    const id = randomUUID(); beginTrackedTask(id);
    const child = spawnTracked(id, process.execPath, ['-e', `const {spawn}=require('node:child_process'); process.on('SIGTERM',()=>{}); const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'}); console.log(child.pid); setInterval(()=>{},1000);`]);
    const [data] = await once(child.stdout, 'data'); const descendant = Number(data.toString().trim());
    const closed = once(child, 'close');
    let cleaned = false;
    void closed.then(() => { cleaned = true; endTrackedTask(id); });
    await cancelAllTasksAndWait();
    expect(cleaned).toBe(true); expect(hasActiveTasks()).toBe(false);
    // A killed descendant can briefly be a zombie until launchd reaps it.
    const { execFileSync } = await import('node:child_process');
    const state = (() => { try { return execFileSync('/bin/ps', ['-o','state=','-p',String(descendant)], {encoding:'utf8'}).trim(); } catch { return ''; } })();
    expect(state === '' || state.startsWith('Z')).toBe(true);
    await cancelTask(id); // Repeated cancellation of a finished task is harmless.
  }, 10000);
});
