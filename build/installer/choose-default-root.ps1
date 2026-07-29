$ErrorActionPreference = 'Stop'

try {
  $systemRoot = [IO.Path]::GetPathRoot([string]$env:SystemRoot)
  if ($systemRoot) {
    $systemRoot = $systemRoot.TrimEnd('\')
  }

  # Get-WmiObject is available in the PowerShell shipped with Windows 7.
  # A failed probe must never become a path value in the NSIS edit control.
  $disks = @(
    Get-WmiObject -Class Win32_LogicalDisk -ErrorAction Stop |
      Where-Object {
        $_.DeviceID -and
        $_.DeviceID -ne $systemRoot -and
        $_.FreeSpace -ne $null
      } |
      Sort-Object FreeSpace -Descending
  )
} catch {
  exit 1
}

foreach ($disk in $disks) {
  $candidate = Join-Path ([string]$disk.DeviceID) 'TTcut'
  $created = $false

  try {
    if (-not (Test-Path -LiteralPath $candidate)) {
      New-Item -ItemType Directory -Path $candidate -ErrorAction Stop | Out-Null
      $created = $true
    }

    $entries = @(Get-ChildItem -LiteralPath $candidate -Force -ErrorAction Stop)
    if ($entries.Count -gt 0) {
      if ($created) {
        Remove-Item -LiteralPath $candidate -Force -ErrorAction SilentlyContinue
      }
      continue
    }

    $probe = Join-Path $candidate '.ttcut-write-test'
    [IO.File]::WriteAllText($probe, '')
    Remove-Item -LiteralPath $probe -Force -ErrorAction Stop
    if ($created) {
      Remove-Item -LiteralPath $candidate -Force -ErrorAction Stop
    }

    # Emit only the successful path, without a formatting newline.
    [Console]::Write($candidate)
    exit 0
  } catch {
    if ($created -and (Test-Path -LiteralPath $candidate)) {
      Remove-Item -LiteralPath $candidate -Force -ErrorAction SilentlyContinue
    }
  }
}

exit 1
