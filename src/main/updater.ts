import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { app, type BrowserWindow } from 'electron';
import { autoUpdater, type NsisUpdater } from 'electron-updater';
import { updateStateSchema, type UpdateState } from '../shared/contracts';
import { IPC } from '../shared/ipc';
import { logLine } from './logger';
import { createUpdateCodeSignatureVerifier } from './update-verifier-runtime';

function publicUpdateError(error: unknown, fallback = 'UPDATE_CHECK_FAILED'): string {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : '';
  return code === 'ERR_UPDATER_INVALID_SIGNATURE'
    ? 'UPDATE_VERIFICATION_FAILED'
    : fallback;
}

function preferencesPath(): string {
  return path.join(app.getPath('userData'), 'update-preferences.json');
}

function loadSkippedVersion(): string | null {
  try {
    const value: unknown = JSON.parse(readFileSync(preferencesPath(), 'utf8'));
    return typeof value === 'object' && value !== null && 'skippedVersion' in value
      && typeof value.skippedVersion === 'string' ? value.skippedVersion : null;
  } catch {
    return null;
  }
}

export class AppUpdater {
  private window: BrowserWindow | null = null;
  private timer: NodeJS.Timeout | null = null;
  private pendingVersion: string | null = null;
  private manualCheck = false;
  private checking = false;
  private state: UpdateState = {
    status: process.platform === 'win32' && app.isPackaged ? 'idle' : 'unsupported',
    version: null,
    message: null,
  };

  constructor() {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.on('checking-for-update', () => this.setState({ status: 'checking', version: null, message: null }));
    autoUpdater.on('update-available', (info) => {
      this.pendingVersion = info.version;
      const skipped = !this.manualCheck && loadSkippedVersion() === info.version;
      this.setState({ status: skipped ? 'skipped' : 'available', version: info.version, message: null });
    });
    autoUpdater.on('update-not-available', () => {
      this.pendingVersion = null;
      this.setState({ status: 'up-to-date', version: app.getVersion(), message: null });
    });
    autoUpdater.on('update-downloaded', (info) => {
      if (this.state.status !== 'downloading' || info.version !== this.pendingVersion) return;
      this.setState({ status: 'downloaded', version: info.version, message: null });
    });
    autoUpdater.on('error', (error) => {
      void logLine('updater', 'WARN', error.stack ?? error.message).catch(() => undefined);
      const fallback = this.state.status === 'downloading' ? 'UPDATE_DOWNLOAD_FAILED' : 'UPDATE_CHECK_FAILED';
      this.setState({ status: 'error', version: null, message: publicUpdateError(error, fallback) });
    });
  }

  private supported(): boolean {
    return process.platform === 'win32'
      && process.arch === 'x64'
      && app.isPackaged
      && existsSync(path.join(process.resourcesPath, 'app-update.yml'));
  }

  private setState(value: UpdateState): UpdateState {
    this.state = updateStateSchema.parse(value);
    if (this.window && !this.window.isDestroyed()) this.window.webContents.send(IPC.updateState, this.state);
    return this.state;
  }

  getState(): UpdateState {
    return this.state;
  }

  start(window: BrowserWindow | null): void {
    this.window = window;
    if (!this.supported()) {
      this.setState({ status: 'unsupported', version: null, message: null });
      return;
    }
    autoUpdater.allowPrerelease = app.getVersion().includes('-');
    const nsisUpdater = autoUpdater as NsisUpdater;
    nsisUpdater.verifyUpdateCodeSignature = createUpdateCodeSignatureVerifier(() => this.pendingVersion);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.check(false), 10_000);
    this.timer.unref?.();
  }

  async check(manual = true): Promise<UpdateState> {
    if (!this.supported()) return this.setState({ status: 'unsupported', version: null, message: null });
    if (this.checking || this.state.status === 'downloading' || this.state.status === 'downloaded') return this.state;
    if (this.timer) clearTimeout(this.timer);
    this.manualCheck = manual;
    this.checking = true;
    this.setState({ status: 'checking', version: null, message: null });
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await logLine('updater', 'WARN', message).catch(() => undefined);
      return this.setState({ status: 'error', version: null, message: publicUpdateError(error) });
    } finally {
      this.checking = false;
    }
    return this.state;
  }

  async download(version: unknown): Promise<UpdateState> {
    if (!this.supported()) return this.setState({ status: 'unsupported', version: null, message: null });
    this.requireAvailableVersion(version);
    this.setState({ status: 'downloading', version: this.pendingVersion, message: null });
    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      await logLine('updater', 'WARN', String(error)).catch(() => undefined);
      return this.setState({ status: 'error', version: null, message: publicUpdateError(error, 'UPDATE_DOWNLOAD_FAILED') });
    }
    return this.state;
  }

  skip(version: unknown): UpdateState {
    if (!this.supported()) return this.setState({ status: 'unsupported', version: null, message: null });
    this.requireAvailableVersion(version);
    const target = preferencesPath();
    const temp = `${target}.${process.pid}.tmp`;
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(temp, `${JSON.stringify({ skippedVersion: version }, null, 2)}\n`, 'utf8');
    renameSync(temp, target);
    return this.setState({ status: 'skipped', version: this.pendingVersion, message: null });
  }

  private requireAvailableVersion(version: unknown): void {
    if (typeof version !== 'string' || version !== this.pendingVersion || this.state.status !== 'available') {
      throw new Error('UPDATE_NOT_AVAILABLE');
    }
  }

  restartToInstall(): void {
    if (this.state.status !== 'downloaded') throw new Error('UPDATE_NOT_READY');
    autoUpdater.quitAndInstall(true, true);
  }
}

let updater: AppUpdater | null = null;

export function getUpdater(): AppUpdater {
  updater ??= new AppUpdater();
  return updater;
}
