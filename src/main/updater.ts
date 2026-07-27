import { app, type BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import { updateStateSchema, type UpdateState } from '../shared/contracts';
import { IPC } from '../shared/ipc';
import { logLine } from './logger';

export class AppUpdater {
  private window: BrowserWindow | null = null;
  private timer: NodeJS.Timeout | null = null;
  private state: UpdateState = {
    status: process.platform === 'win32' && app.isPackaged ? 'idle' : 'unsupported',
    version: null,
    message: null,
  };

  constructor() {
    autoUpdater.on('checking-for-update', () => this.setState({ status: 'checking', version: null, message: null }));
    autoUpdater.on('update-available', (info) => this.setState({ status: 'available', version: info.version, message: null }));
    autoUpdater.on('update-not-available', () => this.setState({ status: 'up-to-date', version: app.getVersion(), message: null }));
    autoUpdater.on('update-downloaded', (info) => {
      this.setState({ status: 'downloaded', version: info.version, message: null });
    });
    autoUpdater.on('error', (error) => {
      void logLine('updater', 'WARN', error.stack ?? error.message).catch(() => undefined);
      this.setState({ status: 'error', version: null, message: error.message });
    });
  }

  private supported(): boolean {
    return process.platform === 'win32' && process.arch === 'x64' && app.isPackaged;
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
    if (!this.supported()) return;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = app.getVersion().includes('-');
    this.timer = setTimeout(() => void this.check(), 10_000);
    this.timer.unref?.();
  }

  async check(): Promise<UpdateState> {
    if (!this.supported()) return this.setState({ status: 'unsupported', version: null, message: null });
    if (this.state.status === 'checking') return this.state;
    this.setState({ status: 'checking', version: null, message: null });
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await logLine('updater', 'WARN', message).catch(() => undefined);
      return this.setState({ status: 'error', version: null, message });
    }
    return this.state;
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
