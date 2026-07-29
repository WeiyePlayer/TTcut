import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { app } from 'electron';

export type InstallationLayout = {
  root: string;
  appRoot: string;
  componentRoot: string;
  userDataRoot: string;
};

export function parseRegistryString(output: string, valueName: string): string | null {
  const expression = new RegExp(`^\\s*${valueName}\\s+REG_(?:SZ|EXPAND_SZ)\\s+(.+?)\\s*$`, 'im');
  return expression.exec(output)?.[1]?.trim() || null;
}

export function readRegisteredInstallRoot(): string | null {
  if (process.platform !== 'win32') return null;
  const command = [
    '$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);',
    "try {$value=(Get-ItemProperty -LiteralPath 'HKCU:\\Software\\TTcut\\Install' -Name InstallRoot -ErrorAction Stop).InstallRoot;",
    "if($value){[Console]::Write([string]$value)}else{exit 1}}catch{exit 1}",
  ].join('');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
  });
  if (result.status !== 0) return null;
  const value = result.stdout.trim();
  return value ? path.resolve(value) : null;
}

export function layoutFromRoot(root: string, userDataRoot: string): InstallationLayout {
  const resolvedRoot = path.resolve(root);
  return {
    root: resolvedRoot,
    appRoot: path.join(resolvedRoot, 'app'),
    componentRoot: path.join(resolvedRoot, 'data', 'components'),
    userDataRoot: path.resolve(userDataRoot),
  };
}

export function resolveInstallationLayout(): InstallationLayout {
  if (!app.isPackaged) {
    const developmentRoot = path.join(app.getPath('userData'), 'development-installation');
    return layoutFromRoot(developmentRoot, app.getPath('userData'));
  }

  const appRoot = path.dirname(path.resolve(process.execPath));
  const derivedRoot = path.dirname(appRoot);
  const registeredRoot = readRegisteredInstallRoot();
  if (!registeredRoot) throw new Error('INSTALL_ROOT_REGISTRY_MISSING');
  if (path.normalize(registeredRoot).toLowerCase() !== path.normalize(derivedRoot).toLowerCase()) {
    if (existsSync(path.join(process.resourcesPath, 'app-update.yml'))) {
      throw new Error('INSTALL_ROOT_REGISTRY_MISMATCH');
    }
    return layoutFromRoot(registeredRoot, app.getPath('userData'));
  }
  return layoutFromRoot(derivedRoot, app.getPath('userData'));
}
