param(
  [string]$LegacyUpdateExe,

  [string]$LegacyInstallRoot,

  [string]$BackupRoot,

  [string]$ReportPath
)

$ErrorActionPreference = 'Stop'
$uninstallerExitCode = -1

function Write-TTcutReport {
  param(
    [string]$Status,
    [string]$ErrorCode,
    [int]$ExitCode,
    [bool]$RollbackSucceeded,
    [string]$Detail = ''
  )

  $report = [ordered]@{
    schema_version = 1
    status = $Status
    legacy_install_root = $LegacyInstallRoot
    legacy_update_exe = $LegacyUpdateExe
    backup_root = $BackupRoot
    uninstaller_exit_code = $ExitCode
    rollback_succeeded = $RollbackSucceeded
    error_code = $ErrorCode
    detail = $Detail
  }

  $reportDirectory = Split-Path -Parent $ReportPath
  if ($reportDirectory) {
    New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null
  }
  $report | ConvertTo-Json -Compress |
    Set-Content -LiteralPath $ReportPath -Encoding UTF8
}

function Get-TreeManifest {
  param([string]$Root)

  if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return @() }
  return @(
    Get-ChildItem -LiteralPath $Root -File -Recurse -Force |
      ForEach-Object {
        [pscustomobject]@{
          path = $_.FullName.Substring($Root.Length).TrimStart('\').Replace('\', '/')
          bytes = $_.Length
          sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
        }
      } |
      Sort-Object path
  )
}

function Assert-MatchingTrees {
  param([string]$Source, [string]$Target)

  $sourceManifest = @(Get-TreeManifest $Source)
  $targetManifest = @(Get-TreeManifest $Target)
  if ($sourceManifest.Count -ne $targetManifest.Count) {
    throw 'Legacy backup file count mismatch.'
  }
  for ($index = 0; $index -lt $sourceManifest.Count; $index += 1) {
    $sourceFile = $sourceManifest[$index]
    $targetFile = $targetManifest[$index]
    if ($sourceFile.path -cne $targetFile.path -or
        $sourceFile.bytes -ne $targetFile.bytes -or
        $sourceFile.sha256 -ne $targetFile.sha256) {
      throw ('Legacy backup verification failed: ' + $sourceFile.path)
    }
  }
}

function Remove-TreeWithRetry {
  param([string]$Path)

  for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path -LiteralPath $Path)) { return }
    Start-Sleep -Milliseconds 500
  }
  throw ('Could not remove directory: ' + $Path)
}

function Save-RegistryKey {
  param([Microsoft.Win32.RegistryKey]$Key, [string]$Destination)

  $values = @()
  if ($Key) {
    foreach ($name in $Key.GetValueNames()) {
      $values += [pscustomobject]@{
        name = $name
        kind = [string]$Key.GetValueKind($name)
        value = $Key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      }
    }
  }
  ConvertTo-Json -InputObject @($values) -Depth 8 |
    Set-Content -LiteralPath $Destination -Encoding UTF8
}

function Restore-RegistryKey {
  param([Microsoft.Win32.RegistryKey]$Base, [string]$Path, [string]$Source)

  $Base.DeleteSubKeyTree($Path, $false)
  $parsedValues = Get-Content -LiteralPath $Source -Raw -Encoding UTF8 | ConvertFrom-Json
  $values = @($parsedValues | Where-Object { $null -ne $_ })
  if ($values.Count -eq 0) { return }
  $key = $Base.CreateSubKey($Path, $true)
  try {
    foreach ($entry in $values) {
      $kind = [Microsoft.Win32.RegistryValueKind]::$($entry.kind)
      $value = $entry.value
      if ($kind -eq [Microsoft.Win32.RegistryValueKind]::Binary) {
        $value = [byte[]]@($entry.value)
      } elseif ($kind -eq [Microsoft.Win32.RegistryValueKind]::MultiString) {
        $value = [string[]]@($entry.value)
      } elseif ($kind -eq [Microsoft.Win32.RegistryValueKind]::DWord) {
        $value = [int]$entry.value
      } elseif ($kind -eq [Microsoft.Win32.RegistryValueKind]::QWord) {
        $value = [long]$entry.value
      } else {
        $value = [string]$entry.value
      }
      $key.SetValue([string]$entry.name, $value, $kind)
    }
  } finally {
    $key.Dispose()
  }
}

function Restore-LegacyInstall {
  param(
    [string]$ExpectedRoot,
    [string]$AppBackup,
    [Microsoft.Win32.RegistryKey]$RegistryBase,
    [string]$RegistryPath,
    [string]$RegistryBackup,
    [string]$ShortcutStatePath,
    [string]$ShortcutBackup
  )

  if (Test-Path -LiteralPath $ExpectedRoot) {
    Remove-TreeWithRetry $ExpectedRoot
  }
  Copy-Item -LiteralPath $AppBackup -Destination $ExpectedRoot -Recurse -Force
  Assert-MatchingTrees $AppBackup $ExpectedRoot
  Restore-RegistryKey $RegistryBase $RegistryPath $RegistryBackup

  $shortcutState = Get-Content -LiteralPath $ShortcutStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($shortcut in @(
    @{ exists = [bool]$shortcutState.desktop; source = (Join-Path $ShortcutBackup 'desktop.lnk'); target = (Join-Path ([Environment]::GetFolderPath('Desktop')) 'TTcut.lnk') },
    @{ exists = [bool]$shortcutState.start_menu; source = (Join-Path $ShortcutBackup 'start-menu.lnk'); target = (Join-Path ([Environment]::GetFolderPath('Programs')) 'TTcut.lnk') }
  )) {
    if ($shortcut.exists) {
      $mustRestore = -not (Test-Path -LiteralPath $shortcut.target -PathType Leaf)
      if (-not $mustRestore) {
        $mustRestore = (Get-FileHash -LiteralPath $shortcut.source -Algorithm SHA256).Hash -ne
          (Get-FileHash -LiteralPath $shortcut.target -Algorithm SHA256).Hash
      }
      if ($mustRestore) {
        New-Item -ItemType Directory -Path (Split-Path -Parent $shortcut.target) -Force | Out-Null
        Copy-Item -LiteralPath $shortcut.source -Destination $shortcut.target -Force
      }
    } elseif (Test-Path -LiteralPath $shortcut.target) {
      Remove-Item -LiteralPath $shortcut.target -Force -ErrorAction SilentlyContinue
    }
  }
}

try {
  $expectedRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'TTcut')).TrimEnd('\')
  $actualRoot = [IO.Path]::GetFullPath($LegacyInstallRoot).TrimEnd('\')
  if (-not $actualRoot.Equals($expectedRoot, [StringComparison]::OrdinalIgnoreCase)) {
    Write-TTcutReport 'failed' 'INVALID_LEGACY_ROOT' -1 $false
    exit 10
  }

  $expectedUpdateExe = Join-Path $expectedRoot 'Update.exe'
  $actualUpdateExe = [IO.Path]::GetFullPath($LegacyUpdateExe)
  if (-not $actualUpdateExe.Equals($expectedUpdateExe, [StringComparison]::OrdinalIgnoreCase)) {
    Write-TTcutReport 'failed' 'INVALID_LEGACY_UNINSTALLER' -1 $false
    exit 11
  }
  if (-not (Test-Path -LiteralPath $actualUpdateExe -PathType Leaf)) {
    Write-TTcutReport 'failed' 'LEGACY_UNINSTALLER_MISSING' -1 $false
    exit 12
  }

  $normalizedBackup = [IO.Path]::GetFullPath($BackupRoot).TrimEnd('\')
  $reportDirectory = [IO.Path]::GetFullPath((Split-Path -Parent $ReportPath)).TrimEnd('\')
  if (-not (Split-Path -Parent $normalizedBackup).Equals($reportDirectory, [StringComparison]::OrdinalIgnoreCase) -or
      $normalizedBackup.Equals($expectedRoot, [StringComparison]::OrdinalIgnoreCase)) {
    Write-TTcutReport 'failed' 'INVALID_BACKUP_ROOT' -1 $false
    exit 13
  }

  $appBackup = Join-Path $normalizedBackup 'app'
  $registryBackup = Join-Path $normalizedBackup 'uninstall-registry.json'
  $shortcutBackup = Join-Path $normalizedBackup 'shortcuts'
  $shortcutStatePath = Join-Path $normalizedBackup 'shortcut-state.json'
  if (Test-Path -LiteralPath $normalizedBackup) {
    Remove-TreeWithRetry $normalizedBackup
  }
  New-Item -ItemType Directory -Path $normalizedBackup -Force | Out-Null
  Copy-Item -LiteralPath $expectedRoot -Destination $appBackup -Recurse -Force
  Assert-MatchingTrees $expectedRoot $appBackup

  $registryBase = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
    [Microsoft.Win32.RegistryHive]::CurrentUser,
    [Microsoft.Win32.RegistryView]::Registry64
  )
  $registryPath = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\TTcut'
  try {
    $legacyKey = $registryBase.OpenSubKey($registryPath, $false)
    try { Save-RegistryKey $legacyKey $registryBackup } finally { if ($legacyKey) { $legacyKey.Dispose() } }

    New-Item -ItemType Directory -Path $shortcutBackup -Force | Out-Null
    $desktopShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'TTcut.lnk'
    $startMenuShortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'TTcut.lnk'
    $shortcutState = [ordered]@{
      desktop = Test-Path -LiteralPath $desktopShortcut -PathType Leaf
      start_menu = Test-Path -LiteralPath $startMenuShortcut -PathType Leaf
    }
    if ($shortcutState.desktop) { Copy-Item -LiteralPath $desktopShortcut -Destination (Join-Path $shortcutBackup 'desktop.lnk') -Force }
    if ($shortcutState.start_menu) { Copy-Item -LiteralPath $startMenuShortcut -Destination (Join-Path $shortcutBackup 'start-menu.lnk') -Force }
    $shortcutState | ConvertTo-Json -Compress | Set-Content -LiteralPath $shortcutStatePath -Encoding UTF8

    $failureCode = $null
    try {
      $uninstaller = Start-Process -FilePath $actualUpdateExe -ArgumentList @('--uninstall', '-s') -Wait -PassThru
      $uninstallerExitCode = $uninstaller.ExitCode
      if ($uninstallerExitCode -ne 0) { throw 'LEGACY_UNINSTALLER_FAILED' }

      $legacyPrefix = $expectedRoot + '\'
      for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
        $busy = @(
          # Get-WmiObject is available in the PowerShell shipped with Windows 7.
          Get-WmiObject Win32_Process -ErrorAction SilentlyContinue |
            Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($legacyPrefix, [StringComparison]::OrdinalIgnoreCase) }
        )
        if ($busy.Count -eq 0 -and (Test-Path -LiteralPath $expectedRoot)) {
          Remove-Item -LiteralPath $expectedRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
        if (-not (Test-Path -LiteralPath $expectedRoot)) { break }
        Start-Sleep -Milliseconds 500
      }
      if (Test-Path -LiteralPath $expectedRoot) { throw 'LEGACY_FILES_REMAIN' }

      $registration = $registryBase.OpenSubKey($registryPath, $false)
      if ($registration) {
        try {
          $registeredRoot = [string]$registration.GetValue('InstallLocation', '')
          $registeredUninstaller = [string]$registration.GetValue('UninstallString', '')
          $pointsToLegacy = $registeredRoot.Equals($expectedRoot, [StringComparison]::OrdinalIgnoreCase) -or
            ($registeredUninstaller.IndexOf($expectedUpdateExe, [StringComparison]::OrdinalIgnoreCase) -ge 0)
        } finally {
          $registration.Dispose()
        }
        if ($pointsToLegacy) { $registryBase.DeleteSubKeyTree($registryPath, $false) }
      }
    } catch {
      $failureCode = if ($_.Exception.Message -in @('LEGACY_UNINSTALLER_FAILED', 'LEGACY_FILES_REMAIN')) {
        $_.Exception.Message
      } else {
        'UNEXPECTED_ERROR'
      }
    }

    if ($failureCode) {
      try {
        Restore-LegacyInstall $expectedRoot $appBackup $registryBase $registryPath $registryBackup $shortcutStatePath $shortcutBackup
        Write-TTcutReport 'failed' ($failureCode + '_RESTORED') $uninstallerExitCode $true
        exit 20
      } catch {
        Write-TTcutReport 'failed' 'LEGACY_ROLLBACK_FAILED' $uninstallerExitCode $false $_.Exception.Message
        [Console]::Error.WriteLine($_.Exception.ToString())
        exit 21
      }
    }
  } finally {
    $registryBase.Dispose()
  }

  Remove-TreeWithRetry $normalizedBackup
  Write-TTcutReport 'success' '' $uninstallerExitCode $false
  exit 0
} catch {
  try { Write-TTcutReport 'failed' 'UNEXPECTED_ERROR' $uninstallerExitCode $false } catch {}
  exit 30
}
