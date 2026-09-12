import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { app, crashReporter, type BrowserWindow } from 'electron';
import { getLogDirectory, getLogPath } from './logger';

// Fatal diagnostics must reach disk before the process exits. Logging failures
// must never replace the original exception or change the normal exit behavior.
function record(message: string): void {
  try {
    mkdirSync(getLogDirectory(), { recursive: true });
    appendFileSync(getLogPath(), `${new Date().toISOString()} | DIAGNOSTIC | ${message.replace(/[\r\n]+/g, ' ').slice(0, 20000)}\n`, 'utf8');
  } catch { /* The user's log directory may be unavailable. */ }
}

export function installRuntimeDiagnostics(): void {
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    record(`Main exception (${origin}): ${error.stack ?? error.message}`);
  });
  app.on('child-process-gone', (_event, details) => {
    record(`Child process gone: ${JSON.stringify(details)}`);
  });
  // Include local native dumps when the user shares the logs folder. Nothing
  // is uploaded; JS handlers alone cannot diagnose GPU/native/OOM crashes.
  try {
    const directory = path.join(getLogDirectory(), 'crashes');
    mkdirSync(directory, { recursive: true });
    app.setPath('crashDumps', directory);
    crashReporter.start({ uploadToServer: false });
    record(`Runtime: ${JSON.stringify({ version: app.getVersion(), platform: process.platform, arch: process.arch, electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, crashDumps: directory })}`);
  } catch (error) {
    record(`Crash diagnostics unavailable: ${String(error)}`);
  }
}

export function attachWindowDiagnostics(window: BrowserWindow): void {
  window.webContents.on('render-process-gone', (_event, details) => {
    record(`Renderer process gone: ${JSON.stringify(details)}`);
  });
  window.webContents.on('console-message', (event) => {
    if (event.level === 'error' || (event.level === 'warning' && event.message.startsWith('[preview]'))) {
      record(`Renderer ${event.level}: ${event.message} (${event.sourceId}:${event.lineNumber})`);
    }
  });
}
