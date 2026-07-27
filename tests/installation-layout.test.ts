import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => 'C:\\Users\\tester\\AppData\\Roaming\\TTcut',
  },
}));

import { layoutFromRoot, parseRegistryString, resolveInstallationLayout } from '../src/main/installation-layout';

describe('installation layout', () => {
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
});
