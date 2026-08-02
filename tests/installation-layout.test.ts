import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  app: {
    isPackaged: false,
    getPath: () => 'C:\\Users\\tester\\AppData\\Roaming\\TTcut',
  },
  spawnSync: vi.fn(),
}));

vi.mock('electron', () => ({
  app: mock.app,
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawnSync: mock.spawnSync,
}));

import { isLocalForgePackage, layoutFromRoot, parseRegistryString, resolveInstallationLayout } from '../src/main/installation-layout';

describe('installation layout', () => {
  const originalExecPath = process.execPath;
  let resourcesPath = '';

  beforeEach(async () => {
    mock.app.isPackaged = false;
    mock.spawnSync.mockReset();
    resourcesPath = await mkdtemp(path.join(os.tmpdir(), 'ttcut-local-package-'));
    Object.defineProperty(process, 'resourcesPath', { configurable: true, value: resourcesPath });
    Object.defineProperty(process, 'execPath', { configurable: true, value: originalExecPath });
  });

  afterEach(async () => {
    Object.defineProperty(process, 'execPath', { configurable: true, value: originalExecPath });
    await rm(resourcesPath, { recursive: true, force: true });
  });

  it('separates replaceable app files from managed components', () => {
    expect(layoutFromRoot('D:\\TTcut', 'C:\\Users\\tester\\AppData\\Roaming\\TTcut')).toEqual({
      root: 'D:\\TTcut',
      appRoot: 'D:\\TTcut\\app',
      componentRoot: 'D:\\TTcut\\data\\components',
      userDataRoot: 'C:\\Users\\tester\\AppData\\Roaming\\TTcut',
    });
  });

  it('uses a user-data-scoped development layout', () => {
    expect(resolveInstallationLayout().componentRoot).toBe(
      'C:\\Users\\tester\\AppData\\Roaming\\TTcut\\development-installation\\data\\components',
    );
  });

  it('parses Unicode registry install roots', () => {
    const output = [
      'HKEY_CURRENT_USER\\Software\\TTcut\\Install',
      '    InstallRoot    REG_SZ    D:\\软件\\TTcut',
    ].join('\r\n');
    expect(parseRegistryString(output, 'InstallRoot')).toBe('D:\\软件\\TTcut');
  });
  it('lets a local package reuse the registered installation Component Store', () => {
    mock.app.isPackaged = true;
    mock.spawnSync.mockReturnValue({ status: 0, stdout: 'E:\\TTcut\r\n' });
    Object.defineProperty(process, 'execPath', {
      configurable: true,
      value: 'D:\\DOCUMENTS\\TTcut\\out\\TTcut-win32-x64\\TTcut.exe',
    });

    expect(resolveInstallationLayout().componentRoot).toBe('E:\\TTcut\\data\\components');
  });

  it('recognizes Forge unpacked output even after local NSIS preparation adds update configuration', async () => {
    mock.app.isPackaged = true;
    mock.spawnSync.mockReturnValue({ status: 0, stdout: 'E:\\TTcut\r\n' });
    Object.defineProperty(process, 'execPath', {
      configurable: true,
      value: 'D:\\DOCUMENTS\\TTcut\\out\\TTcut-win32-x64\\TTcut.exe',
    });
    await writeFile(path.join(resourcesPath, 'app-update.yml'), 'provider: github\n', 'utf8');

    expect(isLocalForgePackage(path.dirname(process.execPath))).toBe(true);
    expect(resolveInstallationLayout().componentRoot).toBe('E:\\TTcut\\data\\components');
  });

  it('rejects a registered root mismatch for an installed package with update configuration', async () => {
    mock.app.isPackaged = true;
    mock.spawnSync.mockReturnValue({ status: 0, stdout: 'E:\\TTcut\r\n' });
    Object.defineProperty(process, 'execPath', {
      configurable: true,
      value: 'D:\\Relocated\\TTcut\\app\\TTcut.exe',
    });
    await writeFile(path.join(resourcesPath, 'app-update.yml'), 'provider: github\n', 'utf8');

    expect(() => resolveInstallationLayout()).toThrow('INSTALL_ROOT_REGISTRY_MISMATCH');
  });
});
