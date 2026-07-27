import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    listeners,
    app: { isPackaged: true, getVersion: vi.fn(() => '1.0.1') },
    checkForUpdates: vi.fn(() => Promise.resolve()),
    quitAndInstall: vi.fn(),
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowPrerelease: false,
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      const current = listeners.get(event) ?? new Set();
      current.add(listener);
      listeners.set(event, current);
    }),
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
  };
});

vi.mock('electron', () => ({
  app: mock.app,
}));

vi.mock('electron-updater', () => ({
  autoUpdater: {
    on: mock.on,
    checkForUpdates: mock.checkForUpdates,
    quitAndInstall: mock.quitAndInstall,
    autoDownload: mock.autoDownload,
    autoInstallOnAppQuit: mock.autoInstallOnAppQuit,
    allowPrerelease: mock.allowPrerelease,
  },
}));

vi.mock('../src/main/logger', () => ({ logLine: vi.fn(() => Promise.resolve()) }));
import { AppUpdater } from '../src/main/updater';

describe('application updater', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mock.listeners.clear();
    mock.checkForUpdates.mockReset().mockResolvedValue(undefined);
    mock.quitAndInstall.mockClear();
    mock.app.isPackaged = true;
  });

  it('configures the NSIS updater and publishes updater states', () => {
    const send = vi.fn();
    const updater = new AppUpdater();
    updater.start({ isDestroyed: () => false, webContents: { send } } as never);
    mock.emit('checking-for-update');
    expect(updater.getState().status).toBe('checking');
    mock.emit('update-available', { version: '1.1.0' });
    expect(updater.getState()).toEqual({ status: 'available', version: '1.1.0', message: null });
    mock.emit('update-not-available');
    expect(updater.getState()).toEqual({ status: 'up-to-date', version: '1.0.1', message: null });
    mock.emit('update-downloaded', { version: '1.1.0' });
    expect(updater.getState()).toEqual({ status: 'downloaded', version: '1.1.0', message: null });
    expect(send).toHaveBeenCalled();

    updater.restartToInstall();
    expect(mock.quitAndInstall).toHaveBeenCalledWith(true, true);
  });

  it('reports manual check errors without forcing a restart', async () => {
    const updater = new AppUpdater();
    updater.start(null);
    mock.checkForUpdates.mockRejectedValueOnce(new Error('offline'));
    await expect(updater.check()).resolves.toEqual({ status: 'error', version: null, message: 'offline' });
    expect(() => updater.restartToInstall()).toThrow('UPDATE_NOT_READY');
    expect(mock.quitAndInstall).not.toHaveBeenCalled();
  });
});
