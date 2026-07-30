import { copyFile, mkdir, mkdtemp, readFile, rm, statfs, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const installerPath = path.join(process.cwd(), 'build', 'installer', 'installer.nsh');
const makeNsisPath = path.join(process.cwd(), 'scripts', 'make-nsis.mjs');
const compareVersionsPath = path.join(process.cwd(), 'build', 'installer', 'compare-versions.ps1');
const chooseDefaultRootPath = path.join(process.cwd(), 'build', 'installer', 'choose-default-root.ps1');
const checkInstallSpacePath = path.join(process.cwd(), 'build', 'installer', 'check-install-space.ps1');
const commitRegistrationPath = path.join(process.cwd(), 'build', 'installer', 'commit-install-registration.ps1');
const finalizeLegacyPath = path.join(process.cwd(), 'build', 'installer', 'finalize-legacy-install.ps1');
const legacyRegistryKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\TTcut';
const legacyRollbackTestUnavailable = process.platform !== 'win32'
  || spawnSync('reg.exe', ['query', legacyRegistryKey]).status === 0;
const powerShell2Probe = process.platform === 'win32'
  ? spawnSync('powershell.exe', [
    '-Version', '2', '-NoProfile', '-NonInteractive',
    '-Command', '$PSVersionTable.PSVersion.Major',
  ], { encoding: 'utf8' })
  : null;
const powerShell2Unavailable = powerShell2Probe?.status !== 0
  || powerShell2Probe.stdout.trim() !== '2';

describe('assisted NSIS installer contract', () => {
  it('forces a current-user three-step flow after install-mode initialization', async () => {
    const source = await readFile(installerPath, 'utf8');
    expect(source).toContain('StrCpy $isForceCurrentInstall "1"');
    expect(source).toContain('StrCpy $isForceMachineInstall "0"');
    expect(source).toContain('!macro customPageAfterChangeDir');
    expect(source).not.toContain('!macro customWelcomePage');
    expect(source).toContain('Page custom TTcutOptionsCreate TTcutOptionsLeave');
  });

  it('uses a compact DPI-aware options layout without a Back button', async () => {
    const source = await readFile(installerPath, 'utf8');
    expect(source).toContain('CreateFont $8 "Segoe UI" 11 700');
    expect(source).toContain('CreateFont $9 "Segoe UI" 9 400');
    expect(source).not.toContain('CreateFont $1 "Segoe UI" 14 700');
    expect(source).toContain('Function TTcutHideBackButton');
    expect(source).toContain('GetDlgItem $2 $HWNDPARENT 3');
    expect(source).toContain('ShowWindow $2 ${SW_HIDE}');
    expect(source).toContain('EnableWindow $2 0');
    expect(source).toContain(
      '!define MUI_PAGE_CUSTOMFUNCTION_SHOW TTcutHideBackButton',
    );
    expect(source).toContain('!macro customFinishPage');
    expect(source).toContain('!insertmacro MUI_PAGE_FINISH');
    expect(source).toContain('${NSD_CreateLabel} 0 110u 100% 24u "$(TTCUT_MIGRATION)"');
  });

  it('turns a selected drive root into its TTcut installation folder', async () => {
    const source = await readFile(installerPath, 'utf8');
    expect(source).toContain('${GetRoot} "$0" $1');
    expect(source).toContain('${If} $0 == $1');
    expect(source).toContain('StrCpy $0 "$0\\TTcut"');
    expect(source).toContain('StrLen $0 $TTcutRoot');
    expect(source).toContain('StrCpy $TTcutRoot "$TTcutRoot\\TTcut"');
    expect(source).not.toContain('$(TTCUT_PATH_ROOT)');
    expect(source).toContain('${NSD_SetText} $TTcutRootField $TTcutRoot');
  });

  it('allows writable drive types while preserving the remaining installer rules', async () => {
    const source = await readFile(installerPath, 'utf8');
    expect(source).not.toContain('GetDriveTypeW');
    expect(source).not.toContain('TTCUT_INSTALLER_DRIVE');
    expect(source).not.toContain('DriveType=3');
    expect(source).not.toContain('TTCUT_PATH_FIXED');
    expect(source).toContain('Function TTcutDirectoryHasEntries');
    expect(source).toContain('StrCpy $7 ""');
    expect(source).toContain('StrCpy $8 ""');
    expect(source).toContain('StrCmp $8 "." ttcut_directory_entry_next');
    expect(source).toContain('StrCmp $8 ".." ttcut_directory_entry_next');
    expect(source).toContain('Call TTcutDirectoryHasEntries');
    expect(source).not.toContain('${FileExists} "$TTcutRoot\\*.*"');
    expect(source).not.toContain('TTCUT_INSTALLER_PRESERVED');
    expect(source).toContain('Function TTcutPathIsWithinBlockedRoot');
    expect(source).toContain(
      'System::Call \'kernel32::GetFullPathNameW(w "$TTcutRoot", i ${NSIS_MAX_STRLEN}, w .r2, p 0)i.r3\'',
    );
    expect(source).toContain('StrCpy $TTcutRoot $2');
    expect(source).not.toContain('GetFullPathName $');
    expect(source).toContain('ReadEnvStr $6 "ProgramW6432"');
    expect(source).not.toContain(
      '$$p=[IO.Path]::GetFullPath($$env:TTCUT_INSTALLER_ROOT)',
    );
    expect(source).toContain(
      'File /oname=check-install-space.ps1 "${PROJECT_DIR}\\build\\installer\\check-install-space.ps1"',
    );
    expect(source).toContain('EnableWindow $TTcutRootField 0');
    expect(source).toContain('EnableWindow $TTcutBrowseButton 0');
    expect(source).toContain('CreateShortcut "$SMPROGRAMS\\TTcut.lnk"');
    expect(source).toContain('CreateShortcut "$DESKTOP\\TTcut.lnk"');
    expect(source).toContain('WriteRegStr HKCU "Software\\TTcut\\Install" "PreservedDataRoot"');
  });

  it('keeps the first-run probes compatible with Windows 7 PowerShell', async () => {
    const source = await readFile(installerPath, 'utf8');
    const chooseDefaultRoot = await readFile(chooseDefaultRootPath, 'utf8');
    const checkInstallSpace = await readFile(checkInstallSpacePath, 'utf8');
    const commitRegistration = await readFile(commitRegistrationPath, 'utf8');
    const compareVersions = await readFile(compareVersionsPath, 'utf8');

    expect(source).toContain(
      'File /oname=choose-default-root.ps1 "${PROJECT_DIR}\\build\\installer\\choose-default-root.ps1"',
    );
    expect(source).toContain(
      'File /oname=check-install-space.ps1 "${PROJECT_DIR}\\build\\installer\\check-install-space.ps1"',
    );
    expect(source).not.toContain('Get-CimInstance');
    expect(source).not.toContain('[IO.DriveInfo]::new');
    expect(chooseDefaultRoot).toContain('Get-WmiObject');
    expect(chooseDefaultRoot).not.toContain('Get-CimInstance');
    expect(checkInstallSpace).toContain(
      'New-Object -TypeName System.IO.DriveInfo -ArgumentList',
    );
    expect(checkInstallSpace).not.toContain('[Parameter(');
    expect(checkInstallSpace).not.toContain('::new(');
    expect(checkInstallSpace).not.toMatch(/Get-ChildItem[^\r\n]*-File/);
    expect(commitRegistration).not.toContain('[ordered]');
    expect(commitRegistration).not.toContain('[Parameter(');
    expect(commitRegistration).not.toContain('ConvertTo-Json');
    expect(commitRegistration).toContain('ConvertTo-TTcutJsonString');
    expect(compareVersions).not.toContain('[Parameter(');
    expect(compareVersions).not.toContain('[pscustomobject]');
    expect(compareVersions).toContain('New-Object -TypeName PSObject -Property');
  });

  it.skipIf(powerShell2Unavailable)('writes a valid registration failure report in PowerShell 2', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ttcut-registration-report-'));
    const installRoot = path.join(root, 'install');
    const reportPath = path.join(root, 'report.json');
    try {
      const result = spawnSync('powershell.exe', [
        '-Version', '2', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', commitRegistrationPath,
        '-InstallRoot', installRoot,
        '-AppGuid', 'invalid-guid',
        '-Version', '1.1.0',
        '-DesktopShortcut', '1',
        '-ReportPath', reportPath,
      ], { encoding: 'utf8' });

      expect(result.status, result.stderr || result.stdout).toBe(11);
      expect(JSON.parse(await readFile(reportPath, 'utf8'))).toMatchObject({
        schema_version: 1,
        status: 'failed',
        install_root: installRoot,
        app_guid: 'invalid-guid',
        version: '1.1.0',
        desktop_shortcut: 1,
        error_code: 'INVALID_APP_GUID',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(powerShell2Unavailable)('distinguishes enough space, low space, and probe failures in PowerShell 2', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ttcut-space-probe-'));
    try {
      const filesystem = await statfs(root, { bigint: true });
      const available = filesystem.bavail * filesystem.bsize;
      const reserve = 512n * 1024n * 1024n;
      const invoke = (installRoot: string, estimatedSizeKb: bigint) => spawnSync(
        'powershell.exe',
        [
          '-Version', '2', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-File', checkInstallSpacePath,
          '-EstimatedSizeKb', estimatedSizeKb.toString(),
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            TTCUT_INSTALLER_ROOT: installRoot,
            TTCUT_INSTALLER_LEGACY: '',
            TTCUT_INSTALLER_LEGACY_APP: '',
          },
        },
      ).status;

      if (available > reserve + 1024n) {
        expect(invoke(root, 1n)).toBe(0);
      }
      expect(invoke(root, (available / 1024n) + 1n)).toBe(1);
      expect(invoke('', 1n)).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('commits and activates the new install before transactionally removing the legacy app', async () => {
    const source = await readFile(installerPath, 'utf8');
    expect(source).toContain('$TTcutRoot\\data\\components.migration');
    expect(source).toContain('--installer-migrate-components');
    expect(source).toContain('Function TTcutRollbackNewInstall');
    expect(source).toContain('StrCpy $TTcutLegacyUninstall "$LOCALAPPDATA\\TTcut\\Update.exe"');
    expect(source).toContain(
      'File /oname=finalize-legacy-install.ps1 "${PROJECT_DIR}\\build\\installer\\finalize-legacy-install.ps1"',
    );
    expect(source).toContain('-LegacyUpdateExe "$TTcutLegacyUninstall"');
    expect(source).not.toContain('ExecWait \'"$TTcutLegacyUninstall" --uninstall -s\'');
    const legacyUninstallIndex = source.indexOf('-LegacyUpdateExe "$TTcutLegacyUninstall"');
    const registrationIndex = source.indexOf(
      '-File "$PLUGINSDIR\\commit-install-registration.ps1"',
    );
    const activationIndex = source.indexOf(
      'Rename "$TTcutRoot\\data\\components.migration" "$TTcutRoot\\data\\components"',
    );
    const shortcutIndex = source.lastIndexOf(
      'CreateShortcut "$DESKTOP\\TTcut.lnk"',
    );
    expect(source).toContain(
      'File /oname=commit-install-registration.ps1 "${PROJECT_DIR}\\build\\installer\\commit-install-registration.ps1"',
    );
    expect(source).toMatch(
      /InitPluginsDir\s+SetOutPath "\$PLUGINSDIR"\s+File \/oname=commit-install-registration\.ps1/,
    );
    expect(source).toContain('-AppGuid "${APP_GUID}"');
    expect(source).toContain('-Version "${VERSION}"');
    expect(source).toContain(
      '-ReportPath "$TTcutRoot\\data\\install-registration-report.json"',
    );
    expect(registrationIndex).toBeGreaterThan(-1);
    expect(registrationIndex).toBeLessThan(activationIndex);
    expect(activationIndex).toBeLessThan(legacyUninstallIndex);
    expect(legacyUninstallIndex).toBeLessThan(shortcutIndex);
    expect(source.slice(activationIndex - 40, activationIndex + 350)).toContain('ClearErrors');
    expect(source.slice(activationIndex, activationIndex + 350)).toContain('${If} ${Errors}');
    expect(source.slice(activationIndex, activationIndex + 350)).toContain('Call TTcutRollbackNewInstall');
    expect(source).toContain('-BackupRoot "$TTcutRoot\\data\\.legacy-install.backup"');
    expect(source).not.toContain('!insertmacro registryAddInstallInfo');
  });

  it('backs up and restores the legacy app, registration, and shortcuts on uninstall failure', async () => {
    const source = await readFile(finalizeLegacyPath, 'utf8');
    expect(source).toContain('function Assert-MatchingTrees');
    expect(source).toContain('Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256');
    expect(source).toContain('function Restore-LegacyInstall');
    expect(source).toContain('Restore-RegistryKey $RegistryBase $RegistryPath $RegistryBackup');
    expect(source).toContain("Copy-Item -LiteralPath $shortcut.source -Destination $shortcut.target -Force");
    expect(source).toContain("Write-TTcutReport 'failed' ($failureCode + '_RESTORED')");
    expect(source).toContain("Write-TTcutReport 'failed' 'LEGACY_ROLLBACK_FAILED'");
  });

  it.skipIf(legacyRollbackTestUnavailable)('restores a legacy app after its uninstaller returns failure', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ttcut-legacy-rollback-'));
    const localAppData = path.join(root, 'local-app-data');
    const legacyRoot = path.join(localAppData, 'TTcut');
    const updateExe = path.join(legacyRoot, 'Update.exe');
    const dataRoot = path.join(root, 'new-install', 'data');
    const reportPath = path.join(dataRoot, 'legacy-uninstall-report.json');
    const backupRoot = path.join(dataRoot, '.legacy-install.backup');
    try {
      await mkdir(legacyRoot, { recursive: true });
      await mkdir(dataRoot, { recursive: true });
      await copyFile(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'where.exe'), updateExe);
      await writeFile(path.join(legacyRoot, 'legacy-marker.txt'), 'keep me', 'utf8');
      expect(spawnSync('reg.exe', [
        'add', legacyRegistryKey,
        '/v', 'InstallLocation',
        '/t', 'REG_SZ',
        '/d', legacyRoot,
        '/f',
      ]).status).toBe(0);

      const result = spawnSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', finalizeLegacyPath,
        '-LegacyUpdateExe', updateExe,
        '-LegacyInstallRoot', legacyRoot,
        '-BackupRoot', backupRoot,
        '-ReportPath', reportPath,
      ], {
        encoding: 'utf8',
        env: { ...process.env, LOCALAPPDATA: localAppData },
      });

      const report = JSON.parse((await readFile(reportPath, 'utf8')).replace(/^\uFEFF/, '')) as {
        status: string;
        error_code: string;
        rollback_succeeded: boolean;
        detail: string;
      };
      expect(result.status, `${result.stderr}\n${JSON.stringify(report)}`).toBe(20);
      expect(report).toMatchObject({
        status: 'failed',
        error_code: 'LEGACY_UNINSTALLER_FAILED_RESTORED',
        rollback_succeeded: true,
      });
      expect(await readFile(path.join(legacyRoot, 'legacy-marker.txt'), 'utf8')).toBe('keep me');
      const restoredRegistration = spawnSync(
        'reg.exe',
        ['query', legacyRegistryKey, '/v', 'InstallLocation'],
        { encoding: 'utf8' },
      );
      expect(restoredRegistration.status).toBe(0);
      expect(restoredRegistration.stdout).toContain(legacyRoot);
    } finally {
      await rm(root, { recursive: true, force: true });
      spawnSync('reg.exe', ['delete', legacyRegistryKey, '/f']);
    }
  }, 20_000);

  it.skipIf(powerShell2Unavailable)('blocks semantic-version downgrades in PowerShell 2, including prerelease downgrades', () => {
    const compare = (installed: string, candidate: string) => spawnSync(
      'powershell.exe',
      [
        '-Version', '2', '-NoProfile', '-NonInteractive',
        '-File', compareVersionsPath,
        '-InstalledVersion', installed,
        '-CandidateVersion', candidate,
      ],
      { encoding: 'utf8' },
    ).status;

    expect(compare('1.2.0', '1.1.0')).toBe(2);
    expect(compare('1.1.0', '1.1.0-beta')).toBe(2);
    expect(compare('1.1.0-beta.10', '1.1.0-beta.2')).toBe(2);
    expect(compare('1.1.0-beta', '1.1.0-beta')).toBe(0);
    expect(compare('1.1.0-beta.2', '1.1.0-beta.10')).toBe(0);
    expect(compare('1.1.0-beta', '1.1.0')).toBe(0);
  });

  it('closes scoped legacy processes and retries without a prompt', async () => {
    const source = await readFile(installerPath, 'utf8');
    expect(source).toContain('auto_close_legacy_processes:');
    expect(source).toContain(
      'File /oname=close-legacy-processes.ps1 "${PROJECT_DIR}\\build\\installer\\close-legacy-processes.ps1"',
    );
    expect(source).toContain('-File "$PLUGINSDIR\\close-legacy-processes.ps1"');
    expect(source).toContain('${If} $4 < 3');
    expect(source).not.toContain('TTCUT_PROCESS_RUNNING');
    expect(source).not.toContain('MB_RETRYCANCEL');
  });

  it('preserves the desktop shortcut preference during silent updates', async () => {
    const source = (await readFile(installerPath, 'utf8')).replaceAll('\r\n', '\n');
    const updateInitializationIndex = source.indexOf(
      '${If} ${isUpdated}\n    StrCpy $TTcutIsRepair "1"',
    );
    const preferenceReadIndex = source.indexOf(
      'ReadRegDWORD $TTcutDesktopShortcut HKCU "Software\\TTcut\\Install" "DesktopShortcut"',
      updateInitializationIndex,
    );
    const registrationHelperIndex = source.indexOf(
      '-DesktopShortcut "$TTcutDesktopShortcut"',
    );
    expect(updateInitializationIndex).toBeGreaterThan(-1);
    expect(preferenceReadIndex).toBeGreaterThan(updateInitializationIndex);
    expect(registrationHelperIndex).toBeGreaterThan(preferenceReadIndex);
    expect(source).toContain(
      '${If} ${FileExists} "$DESKTOP\\TTcut.lnk"',
    );
    expect(source).not.toContain(
      '${IfNot} ${isUpdated}\n    CreateDirectory "$SMPROGRAMS"',
    );
    expect(source).toContain('CreateShortcut "$SMPROGRAMS\\TTcut.lnk" "$INSTDIR\\TTcut.exe"');
  });

  it('uses one default-checked uninstall data switch', async () => {
    const source = await readFile(installerPath, 'utf8');
    expect(source).not.toContain('${NSD_CreateLabel} 0 0 100% 36u "$(TTCUT_DELETE_ALL)"');
    expect(source.match(/\$\(TTCUT_DELETE_ALL\)/g)).toHaveLength(1);
    expect(source).toContain('${NSD_Check} $TTcutDeleteAllCheckbox');
  });

  it('packages the expected Authenticode publisher into app-update.yml', async () => {
    const source = await readFile(makeNsisPath, 'utf8');
    expect(source).toContain("const updatePublisherName = packageJson.author;");
    expect(source).toContain('`publisherName: ${updatePublisherName}`');
  });

  it('routes every semantic-version prerelease through the beta update channel', async () => {
    const [makeNsisSource, builderSource, verifierSource] = await Promise.all([
      readFile(makeNsisPath, 'utf8'),
      readFile(path.resolve('electron-builder.config.cjs'), 'utf8'),
      readFile(path.resolve('scripts/verify-release.mjs'), 'utf8'),
    ]);
    expect(makeNsisSource).toContain("packageVersion.includes('-') ? 'beta' : 'latest'");
    expect(builderSource).toContain("version.includes('-') ? 'beta' : 'latest'");
    expect(verifierSource).toContain("packageJson.version.includes('-') ? 'channel: beta' : 'channel: latest'");
  });
});
