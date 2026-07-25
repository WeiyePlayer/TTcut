import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    listeners,
    app: { isPackaged: true, getVersion: vi.fn(() => '1.0.1') },
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(() => Promise.resolve()),
    quitAndInstall: vi.fn(),
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
  autoUpdater: {
    on: mock.on,
    setFeedURL: mock.setFeedURL,
    checkForUpdates: mock.checkForUpdates,
    quitAndInstall: mock.quitAndInstall,
  },
}));

vi.mock('../src/main/logger', () => ({ logLine: vi.fn(() => Promise.resolve()) }));

import { AppUpdater } from '../src/main/updater';

describe('application updater', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mock.listeners.clear();
    mock.setFeedURL.mockClear();
    mock.checkForUpdates.mockReset().mockResolvedValue(undefined);
    mock.quitAndInstall.mockClear();
    mock.app.isPackaged = true;
  });

  it('configures the stable Squirrel feed and publishes updater states', () => {
    const send = vi.fn();
    const updater = new AppUpdater();
    updater.start({ isDestroyed: () => false, webContents: { send } } as never);
    expect(mock.setFeedURL).toHaveBeenCalledWith({
      url: 'https://update.electronjs.org/WeiyePlayer/TTcut/win32-x64/1.0.1',
    });

    mock.emit('checking-for-update');
    expect(updater.getState().status).toBe('checking');
    mock.emit('update-available');
    expect(updater.getState().status).toBe('available');
    mock.emit('update-not-available');
    expect(updater.getState()).toEqual({ status: 'up-to-date', version: '1.0.1', message: null });
    mock.emit('update-downloaded', {}, '', '1.1.0');
    expect(updater.getState()).toEqual({ status: 'downloaded', version: '1.1.0', message: null });
    expect(send).toHaveBeenCalled();

    updater.restartToInstall();
    expect(mock.quitAndInstall).toHaveBeenCalledTimes(1);
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
