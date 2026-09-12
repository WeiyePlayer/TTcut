// @vitest-environment node
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { BrowserWindow } from 'electron';
import { afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ directory: '', start: vi.fn(), setPath: vi.fn() }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return { app: Object.assign(new EventEmitter(), { setPath: state.setPath, getVersion: () => '1.3.3' }), crashReporter: { start: state.start } };
});
vi.mock('../src/main/logger', () => ({ getLogDirectory: () => state.directory, getLogPath: () => path.join(state.directory, 'app.log') }));
import { app } from 'electron';
import { attachWindowDiagnostics, installRuntimeDiagnostics } from '../src/main/runtime-diagnostics';
afterEach(async () => { app.removeAllListeners(); vi.restoreAllMocks(); vi.clearAllMocks(); if (state.directory) await rm(state.directory, { force: true, recursive: true }); });

it('records native and renderer failures and keeps crash dumps local', async () => {
  state.directory = await mkdtemp(path.join(os.tmpdir(), 'ttcut-diagnostics-'));
  const on = vi.spyOn(process, 'on').mockReturnValue(process);
  installRuntimeDiagnostics();
  const monitor = on.mock.calls.find(([event]) => event === 'uncaughtExceptionMonitor')?.[1];
  expect(on.mock.calls.some(([event]) => event === 'uncaughtException')).toBe(false);
  on.mockRestore();
  expect(state.start).toHaveBeenCalledExactlyOnceWith({ uploadToServer: false });
  expect(state.setPath).toHaveBeenCalledWith('crashDumps', path.join(state.directory, 'crashes'));
  monitor!(new Error('fixture main exception'), 'uncaughtException');
  app.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: 7 });
  const webContents = new EventEmitter();
  attachWindowDiagnostics({ webContents } as unknown as BrowserWindow);
  webContents.emit('render-process-gone', {}, { reason: 'oom', exitCode: -1 });
  webContents.emit('console-message', { level: 'error', message: 'fixture playback failure', sourceId: 'renderer.js', lineNumber: 12 });
  const log = await readFile(path.join(state.directory, 'app.log'), 'utf8');
  expect(log).toContain('"version":"1.3.3"');
  expect(log).toContain('fixture main exception');
  expect(log).toContain('"type":"GPU"');
  expect(log).toContain('"reason":"oom"');
  expect(log).toContain('fixture playback failure');
});
