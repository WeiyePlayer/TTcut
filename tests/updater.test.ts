import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const checkForUpdates = vi.fn(() => Promise.resolve());
  const downloadUpdate = vi.fn(() => Promise.resolve());
  const quitAndInstall = vi.fn();
  const on = vi.fn((event: string, listener: (...args: unknown[]) => void) => {
    const current = listeners.get(event) ?? new Set();
    current.add(listener);
    listeners.set(event, current);
  });
  const updaterApi = {
    on,
    checkForUpdates,
    downloadUpdate,
    quitAndInstall,
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowPrerelease: false,
    verifyUpdateCodeSignature: undefined as ((publisherNames: string[], installerPath: string) => Promise<string | null>) | undefined,
  };
  return {
    listeners,
    app: { isPackaged: true, getVersion: vi.fn(() => '1.0.1'), getPath: vi.fn() },
    checkForUpdates,
    downloadUpdate,
    quitAndInstall,
    logLine: vi.fn(() => Promise.resolve()),
    on,
    updaterApi,
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
  };
});

vi.mock('electron', () => ({
  app: mock.app,
}));

vi.mock('electron-updater', () => ({
  autoUpdater: mock.updaterApi,
}));

vi.mock('../src/main/logger', () => ({ logLine: mock.logLine }));
import { AppUpdater } from '../src/main/updater';

describe('application updater', () => {
  let resourcesPath = '';
  const originalDescriptors = Object.fromEntries(['platform', 'arch', 'resourcesPath'].map((key) => [key, Object.getOwnPropertyDescriptor(process, key)]));

  beforeEach(async () => {
    vi.useFakeTimers();
    mock.listeners.clear();
    mock.checkForUpdates.mockReset().mockResolvedValue(undefined);
    mock.downloadUpdate.mockReset().mockResolvedValue(undefined);
    mock.quitAndInstall.mockClear();
    mock.logLine.mockClear();
    mock.app.isPackaged = true;
    mock.app.getVersion.mockReturnValue('1.0.1');
    mock.updaterApi.allowPrerelease = false;
    mock.updaterApi.autoDownload = true;
    mock.updaterApi.autoInstallOnAppQuit = true;
    mock.updaterApi.verifyUpdateCodeSignature = undefined;
    resourcesPath = await mkdtemp(path.join(os.tmpdir(), 'ttcut-updater-'));
    mock.app.getPath.mockReturnValue(path.join(resourcesPath, 'user-data'));
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    Object.defineProperty(process, 'arch', { configurable: true, value: 'x64' });
    await writeFile(path.join(resourcesPath, 'app-update.yml'), 'provider: github\n', 'utf8');
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: resourcesPath,
    });
  });

  afterEach(async () => {
    vi.clearAllTimers();
    vi.useRealTimers();
    await rm(resourcesPath, { recursive: true, force: true });
    for (const [key, descriptor] of Object.entries(originalDescriptors)) {
      if (descriptor) Object.defineProperty(process, key, descriptor);
      else Reflect.deleteProperty(process, key);
    }
  });

  it('waits for download consent and an explicit restart before installing', async () => {
    const send = vi.fn();
    const updater = new AppUpdater();
    updater.start({ isDestroyed: () => false, webContents: { send } } as never);
    expect(mock.updaterApi.autoDownload).toBe(false);
    expect(mock.updaterApi.autoInstallOnAppQuit).toBe(false);
    mock.emit('checking-for-update');
    expect(updater.getState().status).toBe('checking');
    mock.emit('update-available', { version: '1.1.0' });
    expect(updater.getState()).toEqual({ status: 'available', version: '1.1.0', message: null });
    expect(mock.downloadUpdate).not.toHaveBeenCalled();
    const download = updater.download('1.1.0');
    expect(updater.getState().status).toBe('downloading');
    mock.emit('update-downloaded', { version: '1.1.0' });
    await download;
    expect(updater.getState()).toEqual({ status: 'downloaded', version: '1.1.0', message: null });
    expect(send).toHaveBeenCalled();
    expect(mock.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(mock.quitAndInstall).not.toHaveBeenCalled();

    updater.restartToInstall();
    expect(mock.quitAndInstall).toHaveBeenCalledWith(true, true);
  });

  it('checks on startup without downloading or installing', async () => {
    mock.checkForUpdates.mockImplementation(async () => { mock.emit('update-available', { version: '1.1.0' }); });
    const updater = new AppUpdater();
    updater.start(null);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mock.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(updater.getState().status).toBe('available');
    expect(mock.updaterApi.autoDownload).toBe(false);
    expect(mock.downloadUpdate).not.toHaveBeenCalled();
    expect(mock.quitAndInstall).not.toHaveBeenCalled();
  });

  it('persists a skipped version across launches, allows manual checks, and offers newer versions', async () => {
    const updater = new AppUpdater();
    updater.start(null);
    mock.emit('update-available', { version: '1.1.0' });
    expect(updater.skip('1.1.0')).toEqual({ status: 'skipped', version: '1.1.0', message: null });
    expect(JSON.parse(await readFile(path.join(mock.app.getPath(), 'update-preferences.json'), 'utf8'))).toEqual({ skippedVersion: '1.1.0' });
    expect(mock.downloadUpdate).not.toHaveBeenCalled();

    vi.clearAllTimers();
    mock.listeners.clear();
    mock.checkForUpdates.mockImplementation(async () => { mock.emit('update-available', { version: '1.1.0' }); });
    const relaunched = new AppUpdater();
    relaunched.start(null);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(relaunched.getState().status).toBe('skipped');
    await expect(relaunched.check()).resolves.toEqual({ status: 'available', version: '1.1.0', message: null });
    expect(mock.downloadUpdate).not.toHaveBeenCalled();

    mock.checkForUpdates.mockImplementation(async () => { mock.emit('update-available', { version: '1.2.0' }); });
    await expect(relaunched.check(false)).resolves.toEqual({ status: 'available', version: '1.2.0', message: null });
  });

  it('does not suppress available updates when the saved preference is malformed', async () => {
    await mkdir(mock.app.getPath(), { recursive: true });
    await writeFile(path.join(mock.app.getPath(), 'update-preferences.json'), '{broken');
    const updater = new AppUpdater();
    updater.start(null);
    mock.emit('update-available', { version: '1.1.0' });
    expect(updater.getState().status).toBe('available');
  });

  it('keeps the offer if the skip preference cannot be saved', async () => {
    await writeFile(mock.app.getPath(), 'not a directory');
    const updater = new AppUpdater();
    updater.start(null);
    mock.emit('update-available', { version: '1.1.0' });
    expect(() => updater.skip('1.1.0')).toThrow();
    expect(updater.getState().status).toBe('available');
    expect(mock.downloadUpdate).not.toHaveBeenCalled();
  });

  it('rejects stale or invalid version choices and unrequested download completions', async () => {
    const updater = new AppUpdater();
    updater.start(null);
    await expect(updater.download('1.1.0')).rejects.toThrow('UPDATE_NOT_AVAILABLE');
    mock.emit('update-available', { version: '1.2.0' });
    await expect(updater.download('1.1.0')).rejects.toThrow('UPDATE_NOT_AVAILABLE');
    expect(() => updater.skip({ version: '1.2.0' })).toThrow('UPDATE_NOT_AVAILABLE');
    expect(() => updater.skip('1.1.0')).toThrow('UPDATE_NOT_AVAILABLE');
    mock.emit('update-downloaded', { version: '1.2.0' });
    expect(updater.getState().status).toBe('available');
    expect(mock.downloadUpdate).not.toHaveBeenCalled();
  });

  it('prevents duplicate downloads and rechecks from replacing an active or downloaded update', async () => {
    const updater = new AppUpdater();
    updater.start(null);
    mock.emit('update-available', { version: '1.1.0' });
    let finishDownload!: () => void;
    mock.downloadUpdate.mockImplementationOnce(() => new Promise<void>((resolve) => { finishDownload = resolve; }));
    const pending = updater.download('1.1.0');
    await expect(updater.download('1.1.0')).rejects.toThrow('UPDATE_NOT_AVAILABLE');
    expect(() => updater.skip('1.1.0')).toThrow('UPDATE_NOT_AVAILABLE');
    await updater.check();
    mock.emit('update-downloaded', { version: '1.0.9' });
    expect(updater.getState().status).toBe('downloading');
    mock.emit('update-downloaded', { version: '1.1.0' });
    finishDownload();
    await pending;
    await updater.check();
    expect(mock.checkForUpdates).not.toHaveBeenCalled();
    expect(mock.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(updater.getState()).toEqual({ status: 'downloaded', version: '1.1.0', message: null });
  });

  it.each(['UPDATE_DOWNLOAD_FAILED', 'UPDATE_VERIFICATION_FAILED'])('reports %s without installing and permits a fresh check', async (message) => {
    const updater = new AppUpdater();
    updater.start(null);
    mock.emit('update-available', { version: '1.1.0' });
    const error = Object.assign(new Error('download failed'), { code: message === 'UPDATE_VERIFICATION_FAILED' ? 'ERR_UPDATER_INVALID_SIGNATURE' : 'NETWORK_ERROR' });
    mock.downloadUpdate.mockImplementationOnce(async () => { mock.emit('error', error); throw error; });
    await expect(updater.download('1.1.0')).resolves.toEqual({ status: 'error', version: null, message });
    expect(mock.quitAndInstall).not.toHaveBeenCalled();
    mock.checkForUpdates.mockImplementation(async () => { mock.emit('update-available', { version: '1.1.0' }); });
    await expect(updater.check()).resolves.toEqual({ status: 'available', version: '1.1.0', message: null });
  });

  it('does not let the startup timer duplicate an early manual check', async () => {
    const updater = new AppUpdater();
    updater.start(null);
    await updater.check();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mock.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it.each([['darwin', 'arm64', true], ['win32', 'arm64', true], ['win32', 'x64', false]] as const)('disables updates on %s %s packaged=%s', async (platform, arch, packaged) => {
    Object.defineProperty(process, 'platform', { configurable: true, value: platform });
    Object.defineProperty(process, 'arch', { configurable: true, value: arch });
    mock.app.isPackaged = packaged;
    const updater = new AppUpdater();
    updater.start(null);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await updater.check()).status).toBe('unsupported');
    expect((await updater.download('1.1.0')).status).toBe('unsupported');
    expect(updater.skip('1.1.0').status).toBe('unsupported');
    expect(mock.checkForUpdates).not.toHaveBeenCalled();
    expect(mock.downloadUpdate).not.toHaveBeenCalled();
  });

  it('installs the signed-release verifier before checking for updates', () => {
    const updater = new AppUpdater();

    updater.start(null);

    expect(mock.updaterApi.verifyUpdateCodeSignature).toEqual(expect.any(Function));
  });

  it('enables prerelease updates only for an installed prerelease', () => {
    const stableUpdater = new AppUpdater();
    stableUpdater.start(null);
    expect(mock.updaterApi.allowPrerelease).toBe(false);

    mock.app.getVersion.mockReturnValue('1.2.0-beta.1');
    const betaUpdater = new AppUpdater();
    betaUpdater.start(null);
    expect(mock.updaterApi.allowPrerelease).toBe(true);
  });

  it('reports manual check errors without forcing a restart', async () => {
    const updater = new AppUpdater();
    updater.start(null);
    mock.checkForUpdates.mockRejectedValueOnce(new Error('offline'));
    await expect(updater.check()).resolves.toEqual({ status: 'error', version: null, message: 'UPDATE_CHECK_FAILED' });
    expect(() => updater.restartToInstall()).toThrow('UPDATE_NOT_READY');
    expect(mock.quitAndInstall).not.toHaveBeenCalled();
  });

  it('logs signature diagnostics without exposing raw certificate data to the renderer', () => {
    const updater = new AppUpdater();
    updater.start(null);
    const error = Object.assign(
      new Error('New version is not signed by the application owner: raw info: PRIVATE_DIAGNOSTIC'),
      { code: 'ERR_UPDATER_INVALID_SIGNATURE' },
    );

    mock.emit('error', error);

    expect(updater.getState()).toEqual({
      status: 'error',
      version: null,
      message: 'UPDATE_VERIFICATION_FAILED',
    });
    expect(mock.logLine).toHaveBeenCalledWith('updater', 'WARN', expect.stringContaining('PRIVATE_DIAGNOSTIC'));
  });

  it('silently skips automatic and manual checks when the packaged update configuration is absent', async () => {
    await rm(path.join(resourcesPath, 'app-update.yml'));
    const updater = new AppUpdater();

    updater.start(null);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(mock.checkForUpdates).not.toHaveBeenCalled();
    await expect(updater.check()).resolves.toEqual({ status: 'unsupported', version: null, message: null });
    expect(mock.logLine).not.toHaveBeenCalled();
  });
});
