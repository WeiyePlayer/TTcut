param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z0-9._-]+$')]
  [string]$CaseId,

  [Parameter(Mandatory = $true)]
  [ValidateSet(100, 125, 150, 200)]
  [int]$ExpectedScalePercent,

  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,

  [switch]$InstallAndSmoke
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$evidenceRoot = Join-Path $projectRoot ".baseline\windows-matrix\$CaseId"
$resolvedEvidenceRoot = [System.IO.Path]::GetFullPath($evidenceRoot)
$allowedRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot '.baseline\windows-matrix'))
if (-not $resolvedEvidenceRoot.StartsWith($allowedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Evidence directory escaped the project matrix root.'
}
New-Item -ItemType Directory -Force -Path $resolvedEvidenceRoot | Out-Null

$resolvedInstaller = (Resolve-Path -LiteralPath $InstallerPath).Path
$signature = Get-AuthenticodeSignature -LiteralPath $resolvedInstaller
$collectionWarnings = @()
$windowsVersion = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
$buildNumber = [int]$windowsVersion.CurrentBuildNumber
$totalPhysicalMemory = $null
try {
  $totalPhysicalMemory = [int64](Get-CimInstance Win32_ComputerSystem -ErrorAction Stop).TotalPhysicalMemory
} catch {
  $collectionWarnings += "Physical-memory inventory unavailable to the standard user: $($_.Exception.Message)"
}
$os = [ordered]@{
  registry_product_name = [string]$windowsVersion.ProductName
  display_version = [string]$windowsVersion.DisplayVersion
  build_number = $buildNumber
  update_build_revision = [int]$windowsVersion.UBR
  architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
  total_physical_memory_bytes = $totalPhysicalMemory
}
$dpiApi = Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class TTcutDpiProbe {
  [DllImport("user32.dll")]
  public static extern uint GetDpiForSystem();
}
'@ -PassThru
$appliedDpi = [int]$dpiApi::GetDpiForSystem()
$actualScale = [int][Math]::Round($appliedDpi / 96 * 100)
try {
  $videoControllers = @(Get-CimInstance Win32_VideoController -ErrorAction Stop | Select-Object Name, DriverVersion, AdapterRAM, VideoModeDescription)
} catch {
  $videoControllers = @()
  $collectionWarnings += "GPU inventory unavailable to the standard user: $($_.Exception.Message)"
}
$systemDrive = [System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($env:LOCALAPPDATA))
$installerHash = (Get-FileHash -LiteralPath $resolvedInstaller -Algorithm SHA256).Hash.ToLowerInvariant()

$smoke = [ordered]@{
  requested = [bool]$InstallAndSmoke
  installed = $false
  launched = $false
  process_exit_code = $null
}

if ($InstallAndSmoke) {
  if ($signature.Status -ne 'Valid') { throw "Refusing public RC smoke install because Authenticode status is $($signature.Status)." }
  $installer = Start-Process -FilePath $resolvedInstaller -ArgumentList '--silent' -PassThru -Wait -WindowStyle Hidden
  $smoke.process_exit_code = $installer.ExitCode
  if ($installer.ExitCode -ne 0) { throw "Installer exited with code $($installer.ExitCode)." }
  $candidateExecutables = @(
    Join-Path $env:LOCALAPPDATA 'TTcut\TTcut.exe'
    Get-ChildItem (Join-Path $env:LOCALAPPDATA 'TTcut') -Directory -Filter 'app-*' -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending |
      ForEach-Object { Join-Path $_.FullName 'TTcut.exe' }
  )
  $application = $candidateExecutables | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if (-not $application) { throw 'TTcut.exe was not found in the expected per-user installation directory.' }
  $smoke.installed = $true
  $process = Start-Process -FilePath $application -PassThru
  Start-Sleep -Seconds 8
  $smoke.launched = -not $process.HasExited
  if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force }
}

$evidence = [ordered]@{
  schema_version = 1
  case_id = $CaseId
  captured_at = (Get-Date).ToUniversalTime().ToString('o')
  installer = [ordered]@{
    path = $resolvedInstaller
    sha256 = $installerHash
    signature_status = [string]$signature.Status
    signer_subject = [string]$signature.SignerCertificate.Subject
    signer_thumbprint = [string]$signature.SignerCertificate.Thumbprint
    timestamp_subject = [string]$signature.TimeStamperCertificate.Subject
  }
  operating_system = $os
  inferred_windows_family = if ($buildNumber -ge 22000) { 'Windows 11' } else { 'Windows 10' }
  display = [ordered]@{
    expected_scale_percent = $ExpectedScalePercent
    applied_dpi = $appliedDpi
    actual_scale_percent = $actualScale
    matches_expected = ($actualScale -eq $ExpectedScalePercent)
  }
  gpu = $videoControllers
  collection_warnings = $collectionWarnings
  environment = [ordered]@{
    username_contains_non_ascii = ($env:USERNAME -match '[^\x00-\x7F]')
    local_app_data = $env:LOCALAPPDATA
    system_drive_free_bytes = [int64]$systemDrive.AvailableFreeSpace
    system_drive_used_bytes = [int64]($systemDrive.TotalSize - $systemDrive.AvailableFreeSpace)
  }
  smoke = $smoke
}

$jsonPath = Join-Path $resolvedEvidenceRoot 'environment.json'
$evidence | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $jsonPath -Encoding UTF8
if (-not $evidence.display.matches_expected) { throw "Expected $ExpectedScalePercent% scaling, but the current user session reports $actualScale%." }
Write-Output $jsonPath
