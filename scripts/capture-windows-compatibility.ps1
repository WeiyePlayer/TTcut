param(
  [ValidatePattern('^[A-Za-z0-9._-]+$')]
  [string]$CaseId = 'local',

  [ValidateSet(100, 125, 150, 200)]
  [int]$ExpectedScalePercent = 100,

  [string]$InstallerPath = '',

  [switch]$InstallAndSmoke,
  [switch]$RequireValidSignature,

  [ValidatePattern('^[A-Fa-f0-9]{40,64}$')]
  [string]$ExpectedSignerThumbprint = ''
)

$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$allowedRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot '.baseline\windows-compatibility'))
$evidenceRoot = [System.IO.Path]::GetFullPath((Join-Path $allowedRoot $CaseId))
if (-not $evidenceRoot.StartsWith($allowedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Evidence directory escaped the Windows compatibility root.'
}
New-Item -ItemType Directory -Force -Path $evidenceRoot | Out-Null

$windowsVersion = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
$buildNumber = [int]$windowsVersion.CurrentBuildNumber
$installationType = [string]$windowsVersion.InstallationType
$architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
$supported = $installationType -eq 'Client' -and $architecture -eq 'X64' -and ($buildNumber -eq 19045 -or $buildNumber -ge 22000)
$reason = if ($installationType -ne 'Client') { 'windows_server' } elseif ($architecture -ne 'X64') { 'unsupported_architecture' } elseif (-not $supported) { 'unsupported_windows_build' } else { 'supported' }

$dpiApi = Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class TTcutDpiProbe {
  [DllImport("user32.dll")]
  public static extern uint GetDpiForSystem();
}
'@ -PassThru
$appliedDpi = [int]$dpiApi::GetDpiForSystem()
$actualScale = [int][Math]::Round($appliedDpi / 96 * 100)
$warnings = @()
try {
  $videoControllers = @(Get-CimInstance Win32_VideoController -ErrorAction Stop | Select-Object Name, DriverVersion, AdapterRAM, VideoModeDescription)
} catch {
  $videoControllers = @()
  $warnings += "GPU inventory was unavailable: $($_.Exception.Message)"
}

$installer = $null
$signature = $null
$smoke = [ordered]@{ requested = [bool]$InstallAndSmoke; installed = $false; launched = $false; process_exit_code = $null }
if ($InstallerPath) {
  $resolvedInstaller = (Resolve-Path -LiteralPath $InstallerPath).Path
  $signature = Get-AuthenticodeSignature -LiteralPath $resolvedInstaller
  $actualThumbprint = [string]$signature.SignerCertificate.Thumbprint
  if ($ExpectedSignerThumbprint -and $actualThumbprint.Replace(' ', '').ToUpperInvariant() -ne $ExpectedSignerThumbprint.Replace(' ', '').ToUpperInvariant()) {
    throw 'Installer signer thumbprint does not match the expected signer.'
  }
  if ($RequireValidSignature -and $signature.Status -ne 'Valid') {
    throw "Installer Authenticode trust status is $($signature.Status), not Valid."
  }
  $installer = [ordered]@{
    path = $resolvedInstaller
    size = (Get-Item -LiteralPath $resolvedInstaller).Length
    sha256 = (Get-FileHash -LiteralPath $resolvedInstaller -Algorithm SHA256).Hash.ToLowerInvariant()
    signature_status = [string]$signature.Status
    signer_subject = [string]$signature.SignerCertificate.Subject
    signer_thumbprint = $actualThumbprint
    timestamp_subject = [string]$signature.TimeStamperCertificate.Subject
  }
}

if ($InstallAndSmoke) {
  if (-not $InstallerPath) { throw '-InstallAndSmoke requires -InstallerPath.' }
  $installerProcess = Start-Process -FilePath $installer.path -ArgumentList '--silent' -PassThru -Wait -WindowStyle Hidden
  $smoke.process_exit_code = $installerProcess.ExitCode
  if ($installerProcess.ExitCode -ne 0) { throw "Installer exited with code $($installerProcess.ExitCode)." }
  $application = @(
    Join-Path $env:LOCALAPPDATA 'TTcut\TTcut.exe'
    Get-ChildItem (Join-Path $env:LOCALAPPDATA 'TTcut') -Directory -Filter 'app-*' -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending |
      ForEach-Object { Join-Path $_.FullName 'TTcut.exe' }
  ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if (-not $application) { throw 'TTcut.exe was not found after installation.' }
  $smoke.installed = $true
  $process = Start-Process -FilePath $application -PassThru
  Start-Sleep -Seconds 8
  $smoke.launched = -not $process.HasExited
  if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force }
}

$evidence = [ordered]@{
  schema_version = 2
  case_id = $CaseId
  captured_at = (Get-Date).ToUniversalTime().ToString('o')
  compatibility = [ordered]@{
    supported = $supported
    reason = $reason
    build_number = $buildNumber
    display_version = [string]$windowsVersion.DisplayVersion
    installation_type = $installationType
    architecture = $architecture
  }
  display = [ordered]@{
    expected_scale_percent = $ExpectedScalePercent
    applied_dpi = $appliedDpi
    actual_scale_percent = $actualScale
    matches_expected = ($actualScale -eq $ExpectedScalePercent)
  }
  gpu = $videoControllers
  installer = $installer
  smoke = $smoke
  warnings = $warnings
}

$jsonPath = Join-Path $evidenceRoot 'environment.json'
$evidence | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $jsonPath -Encoding UTF8
if (-not $supported) { throw "This system is outside the TTcut compatibility policy: $reason." }
if ($actualScale -ne $ExpectedScalePercent) { throw "Expected $ExpectedScalePercent% scaling, but Windows reports $actualScale%." }
Write-Output $jsonPath

