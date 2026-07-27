param(
  [Parameter(Mandatory = $true)]
  [string]$InstallRoot,

  [Parameter(Mandatory = $true)]
  [string]$AppGuid,

  [Parameter(Mandatory = $true)]
  [string]$Version,

  [Parameter(Mandatory = $true)]
  [ValidateSet(0, 1)]
  [int]$DesktopShortcut,

  [Parameter(Mandatory = $true)]
  [string]$ReportPath
)

$ErrorActionPreference = 'Stop'

function Write-TTcutRegistrationReport {
  param(
    [string]$Status,
    [string]$ErrorCode
  )

  $report = [ordered]@{
    schema_version = 1
    status = $Status
    install_root = $InstallRoot
    app_guid = $AppGuid
    version = $Version
    desktop_shortcut = $DesktopShortcut
    error_code = $ErrorCode
  }

  $reportDirectory = Split-Path -Parent $ReportPath
  if ($reportDirectory) {
    New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null
  }
  $report | ConvertTo-Json -Compress |
    Set-Content -LiteralPath $ReportPath -Encoding UTF8
}

try {
  $normalizedRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
  $rootPath = [IO.Path]::GetPathRoot($normalizedRoot).TrimEnd('\')
  if ($normalizedRoot.Equals(
    $rootPath,
    [StringComparison]::OrdinalIgnoreCase
  )) {
    Write-TTcutRegistrationReport 'failed' 'INVALID_INSTALL_ROOT'
    exit 10
  }
  if ($AppGuid -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') {
    Write-TTcutRegistrationReport 'failed' 'INVALID_APP_GUID'
    exit 11
  }

  $appRoot = Join-Path $normalizedRoot 'app'
  $appExe = Join-Path $appRoot 'TTcut.exe'
  $uninstaller = Join-Path $appRoot 'Uninstall TTcut.exe'
  if (-not (Test-Path -LiteralPath $appExe -PathType Leaf) -or
      -not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
    Write-TTcutRegistrationReport 'failed' 'INSTALL_FILES_MISSING'
    exit 12
  }

  $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
    [Microsoft.Win32.RegistryHive]::CurrentUser,
    [Microsoft.Win32.RegistryView]::Registry64
  )
  try {
    $layout = $base.CreateSubKey('Software\TTcut\Install', $true)
    try {
      $layout.SetValue('InstallRoot', $normalizedRoot, [Microsoft.Win32.RegistryValueKind]::String)
      $layout.SetValue('DesktopShortcut', $DesktopShortcut, [Microsoft.Win32.RegistryValueKind]::DWord)
      $layout.SetValue('LayoutVersion', 1, [Microsoft.Win32.RegistryValueKind]::DWord)
      $layout.DeleteValue('PreservedDataRoot', $false)
    } finally {
      $layout.Dispose()
    }

    $application = $base.CreateSubKey(('Software\' + $AppGuid), $true)
    try {
      $application.SetValue('InstallLocation', $appRoot, [Microsoft.Win32.RegistryValueKind]::String)
      $application.SetValue('KeepShortcuts', 'true', [Microsoft.Win32.RegistryValueKind]::String)
      $application.SetValue('ShortcutName', 'TTcut', [Microsoft.Win32.RegistryValueKind]::String)
    } finally {
      $application.Dispose()
    }

    $uninstallPath = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $AppGuid
    $uninstallKey = $base.CreateSubKey($uninstallPath, $true)
    try {
      $uninstallCommand = '"' + $uninstaller + '" /currentuser'
      $uninstallKey.SetValue('DisplayName', ('TTcut ' + $Version), [Microsoft.Win32.RegistryValueKind]::String)
      $uninstallKey.SetValue('DisplayVersion', $Version, [Microsoft.Win32.RegistryValueKind]::String)
      $uninstallKey.SetValue('DisplayIcon', (Join-Path $appRoot 'uninstallerIcon.ico'), [Microsoft.Win32.RegistryValueKind]::String)
      $uninstallKey.SetValue('Publisher', 'weiye', [Microsoft.Win32.RegistryValueKind]::String)
      $uninstallKey.SetValue('InstallLocation', $appRoot, [Microsoft.Win32.RegistryValueKind]::String)
      $uninstallKey.SetValue('UninstallString', $uninstallCommand, [Microsoft.Win32.RegistryValueKind]::String)
      $uninstallKey.SetValue('QuietUninstallString', ($uninstallCommand + ' /S'), [Microsoft.Win32.RegistryValueKind]::String)
      $uninstallKey.SetValue('NoModify', 1, [Microsoft.Win32.RegistryValueKind]::DWord)
      $uninstallKey.SetValue('NoRepair', 1, [Microsoft.Win32.RegistryValueKind]::DWord)
    } finally {
      $uninstallKey.Dispose()
    }
  } finally {
    $base.Dispose()
  }

  $verifyBase = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
    [Microsoft.Win32.RegistryHive]::CurrentUser,
    [Microsoft.Win32.RegistryView]::Registry64
  )
  try {
    $verifyLayout = $verifyBase.OpenSubKey('Software\TTcut\Install', $false)
    $verifyUninstall = $verifyBase.OpenSubKey(
      ('Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $AppGuid),
      $false
    )
    try {
      if (-not $verifyLayout -or -not $verifyUninstall -or
          $verifyLayout.GetValue('InstallRoot') -ne $normalizedRoot -or
          $verifyUninstall.GetValue('InstallLocation') -ne $appRoot) {
        Write-TTcutRegistrationReport 'failed' 'REGISTRATION_READBACK_FAILED'
        exit 13
      }
    } finally {
      if ($verifyLayout) {
        $verifyLayout.Dispose()
      }
      if ($verifyUninstall) {
        $verifyUninstall.Dispose()
      }
    }
  } finally {
    $verifyBase.Dispose()
  }

  Write-TTcutRegistrationReport 'success' ''
  exit 0
} catch {
  try {
    Write-TTcutRegistrationReport 'failed' 'UNEXPECTED_ERROR'
  } catch {
  }
  exit 20
}
