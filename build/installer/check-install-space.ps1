param(
  [int64]$EstimatedSizeKb
)

$ErrorActionPreference = 'Stop'
$safetyReserveBytes = [int64]536870912

function Get-TTcutTreeBytes {
  param([string]$Root)

  if ([string]::IsNullOrEmpty($Root) -or
      -not (Test-Path -LiteralPath $Root -PathType Container)) {
    return [int64]0
  }

  $total = [int64]0
  # PowerShell 2 has no -File switch. Filter the FileInfo objects instead.
  $files = @(
    Get-ChildItem -LiteralPath $Root -Recurse -Force -ErrorAction Stop |
      Where-Object { -not $_.PSIsContainer }
  )
  foreach ($file in $files) {
    $total += [int64]$file.Length
  }
  return $total
}

try {
  if ($EstimatedSizeKb -le 0) {
    exit 2
  }

  $installRoot = [string]$env:TTCUT_INSTALLER_ROOT
  if ([string]::IsNullOrEmpty($installRoot)) {
    exit 2
  }

  $driveRoot = [IO.Path]::GetPathRoot($installRoot)
  if ([string]::IsNullOrEmpty($driveRoot)) {
    exit 2
  }

  # Construct the object through New-Object for the PowerShell 2 runtime.
  $drive = New-Object -TypeName System.IO.DriveInfo -ArgumentList @($driveRoot)
  $required = ([int64]$EstimatedSizeKb * [int64]1024)
  $required += Get-TTcutTreeBytes ([string]$env:TTCUT_INSTALLER_LEGACY)

  $legacyUpdate = [string]$env:TTCUT_INSTALLER_LEGACY_APP
  if (-not [string]::IsNullOrEmpty($legacyUpdate) -and
      (Test-Path -LiteralPath $legacyUpdate -PathType Leaf)) {
    $required += Get-TTcutTreeBytes (Split-Path -Parent $legacyUpdate)
  }

  $required += $safetyReserveBytes
  if ([int64]$drive.AvailableFreeSpace -lt $required) {
    exit 1
  }
  exit 0
} catch {
  # 1 means a real low-space result; 2 means the check itself failed.
  exit 2
}
