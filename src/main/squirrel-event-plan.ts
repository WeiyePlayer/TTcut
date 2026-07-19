import path from 'node:path';

export type SquirrelEventPlan =
  | { kind: 'quit' }
  | { kind: 'shortcut'; updateExecutable: string; args: [string, string] };

export function squirrelEventPlan(platform: NodeJS.Platform, event: string | undefined, executable: string): SquirrelEventPlan | null {
  if (platform !== 'win32') return null;
  if (event === '--squirrel-obsolete') return { kind: 'quit' };
  if (event !== '--squirrel-install' && event !== '--squirrel-updated' && event !== '--squirrel-uninstall') return null;
  return {
    kind: 'shortcut',
    updateExecutable: path.resolve(path.dirname(executable), '..', 'Update.exe'),
    args: [event === '--squirrel-uninstall' ? '--removeShortcut' : '--createShortcut', path.basename(executable)],
  };
}
