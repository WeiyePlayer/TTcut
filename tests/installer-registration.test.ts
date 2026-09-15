import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const compilerCache = path.join(process.env.LOCALAPPDATA ?? '', 'electron-builder', 'Cache', 'nsis-3.0.4.1');
const compiler = process.env.TTCUT_MAKENSIS_PATH ?? [
  path.join(compilerCache, 'Bin', 'makensis.exe'),
  ...(existsSync(compilerCache) ? readdirSync(compilerCache).map(
    (entry) => path.join(compilerCache, entry, 'Bin', 'makensis.exe'),
  ) : []),
].find(existsSync);
const includePath = path.resolve('build/installer/registration.nsh');

describe.skipIf(process.platform !== 'win32' || !compiler)('native installer registration (requires NSIS)', () => {
  it.each([
    { name: 'Chinese paths with spaces, desktop shortcut on', shortcut: 1, missing: false, invalidKey: false },
    { name: 'repair preserves desktop shortcut off', shortcut: 0, missing: false, invalidKey: false },
    { name: 'missing uninstaller fails before registration', shortcut: 1, missing: true, invalidKey: false },
    { name: 'registry write failure retains a diagnostic', shortcut: 1, missing: false, invalidKey: true },
  ])('$name', async ({ shortcut, missing, invalidKey }) => {
    if (!compiler) throw new Error('NSIS compiler is required for Windows registration tests');
    const root = await mkdtemp(path.join(os.tmpdir(), 'ttcut-native-registration-'));
    const registryRoot = `Software\\TTcutRegistrationTests\\${path.basename(root)}`;
    const layoutKey = `${registryRoot}\\${invalidKey ? 'x'.repeat(300) : 'Install'}`;
    const appRoot = path.join(root, '中文 安装 [test]', 'app');
    const installer = path.join(root, 'registration-test.exe');
    const sourcePath = path.join(root, 'registration-test.nsi');
    const resultPath = path.join(root, 'result.ini');
    let diagnostic = '';
    try {
      const source = String.raw`
Unicode true
RequestExecutionLevel user
SilentInstall silent
OutFile "${installer}"
!define APP_GUID "12345678-1234-1234-1234-123456789012"
!define UNINSTALL_APP_KEY "unused"
!define VERSION "1.3.5"
!define TTCUT_LAYOUT_KEY "${layoutKey}"
!define TTCUT_APPLICATION_KEY "${registryRoot}\Application"
!define TTCUT_UNINSTALL_KEY "${registryRoot}\Uninstall"
Var TTcutRoot
Var TTcutDesktopShortcut
!include "${includePath}"
Section
  StrCpy $INSTDIR "${appRoot}"
  ${'${GetParent}'} "$INSTDIR" $TTcutRoot
  StrCpy $TTcutDesktopShortcut "${shortcut}"
  CreateDirectory "$INSTDIR"
  FileOpen $0 "$INSTDIR\TTcut.exe" w
  FileClose $0
  ${missing ? '' : 'FileOpen $0 "$INSTDIR\\Uninstall TTcut.exe" w\n  FileClose $0'}
  SetRegView 64
  ${invalidKey || missing ? '' : `WriteRegDWORD HKCU "${layoutKey}" "DesktopShortcut" ${1 - shortcut}`}
  ; Registration must work with no shell discoverable through PATH.
  System::Call 'kernel32::SetEnvironmentVariableW(w "PATH", w "")i.r0'
  Call TTcutCommitRegistration
  FileOpen $0 "${resultPath}" w
  FileWriteWord $0 0xFEFF
  FileClose $0
  WriteINIStr "${resultPath}" "Result" "Error" "$TTcutRegistrationError"
  WriteINIStr "${resultPath}" "Result" "Log" "$TTcutRegistrationLog"
  ReadRegStr $0 HKCU "${layoutKey}" "InstallRoot"
  WriteINIStr "${resultPath}" "Result" "InstallRoot" "$0"
  ReadRegDWORD $0 HKCU "${layoutKey}" "DesktopShortcut"
  WriteINIStr "${resultPath}" "Result" "DesktopShortcut" "$0"
  ReadRegDWORD $0 HKCU "${layoutKey}" "LayoutVersion"
  WriteINIStr "${resultPath}" "Result" "LayoutVersion" "$0"
  ReadRegStr $0 HKCU "${registryRoot}\Application" "InstallLocation"
  WriteINIStr "${resultPath}" "Result" "ApplicationRoot" "$0"
  ReadRegStr $0 HKCU "${registryRoot}\Uninstall" "QuietUninstallString"
  WriteINIStr "${resultPath}" "Result" "QuietUninstallString" "$0"
  DeleteRegKey HKCU "${registryRoot}"
SectionEnd
`;
      // File is generated test input, not a source rewrite.
      await writeFile(sourcePath, '\uFEFF' + source, 'utf8');
      const compile = spawnSync(compiler, ['/V2', sourcePath], { encoding: 'utf8', windowsHide: true });
      expect(compile.status, compile.stdout + compile.stderr).toBe(0);
      const run = spawnSync(installer, [], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
      expect(run.status, run.error?.message ?? run.stderr).toBe(0);
      const result = (await readFile(resultPath)).toString('utf16le').replace(/^\uFEFF/, '');
      const value = (name: string) => result.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim() ?? '';
      if (missing) {
        expect(value('Error')).toBe('INSTALL_FILES_MISSING');
        expect(value('InstallRoot')).toBe('');
      } else if (invalidKey) {
        expect(value('Error')).toBe(`WRITE: ${layoutKey}\\InstallRoot`);
      } else {
        expect(value('Error')).toBe('');
        expect(value('InstallRoot')).toBe(path.dirname(appRoot));
        expect(value('ApplicationRoot')).toBe(appRoot);
        expect(value('DesktopShortcut')).toBe(String(shortcut));
        expect(value('LayoutVersion')).toBe('1');
        expect(value('QuietUninstallString')).toBe(`"${appRoot}\\Uninstall TTcut.exe" /currentuser /S`);
      }
      diagnostic = value('Log');
      if (value('Error')) {
        expect(diagnostic).not.toBe('');
        expect(path.dirname(diagnostic).toLowerCase()).toBe(os.tmpdir().toLowerCase());
      } else {
        expect(diagnostic).toBe('');
      }
      await rm(appRoot, { recursive: true, force: true });
      if (diagnostic) {
        const log = (await readFile(diagnostic)).toString('utf16le');
        expect(log).toContain(`Error=${value('Error')}`);
        expect(log).toContain(`InstallRoot=${path.dirname(appRoot)}`);
      }
    } finally {
      spawnSync('reg.exe', ['delete', `HKCU\\${registryRoot}`, '/f', '/reg:64'], { windowsHide: true });
      if (diagnostic && path.dirname(diagnostic).toLowerCase() === os.tmpdir().toLowerCase()) {
        await rm(diagnostic, { force: true });
      }
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
