import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { squirrelEventPlan } from '../src/main/squirrel-event-plan';

describe('Squirrel startup lifecycle', () => {
  const executable = 'C:\\Users\\tester\\AppData\\Local\\TTcut\\app-1.0.0\\TTcut.exe';
  const updateExecutable = path.resolve(path.dirname(executable), '..', 'Update.exe');

  it.each(['--squirrel-install', '--squirrel-updated'])('creates the installed shortcut for %s', (event) => {
    expect(squirrelEventPlan('win32', event, executable)).toEqual({
      kind: 'shortcut',
      updateExecutable,
      args: ['--createShortcut', 'TTcut.exe'],
    });
  });

  it('removes the installed shortcut during uninstall', () => {
    expect(squirrelEventPlan('win32', '--squirrel-uninstall', executable)).toEqual({
      kind: 'shortcut',
      updateExecutable,
      args: ['--removeShortcut', 'TTcut.exe'],
    });
  });

  it('ignores normal launches and non-Windows platforms', () => {
    expect(squirrelEventPlan('win32', undefined, executable)).toBeNull();
    expect(squirrelEventPlan('darwin', '--squirrel-install', executable)).toBeNull();
  });
});
