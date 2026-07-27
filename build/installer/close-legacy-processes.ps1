$ErrorActionPreference = 'Stop'

$componentRoot = $env:TTCUT_INSTALLER_LEGACY
if ([string]::IsNullOrWhiteSpace($componentRoot)) {
  exit 0
}

$componentPrefix = [IO.Path]::GetFullPath($componentRoot).TrimEnd('\') + '\'
$legacyAppPrefix = [IO.Path]::GetFullPath(
  (Join-Path $env:LOCALAPPDATA 'TTcut')
).TrimEnd('\') + '\'

function Get-TTcutBusyProcess {
  @(
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object {
        $_.ExecutablePath -and (
          (
            $_.Name -ieq 'TTcut.exe' -and
            $_.ExecutablePath.StartsWith(
              $legacyAppPrefix,
              [StringComparison]::OrdinalIgnoreCase
            )
          ) -or (
            ($_.Name -ieq 'python.exe' -or $_.Name -ieq 'ffmpeg.exe') -and
            $_.ExecutablePath.StartsWith(
              $componentPrefix,
              [StringComparison]::OrdinalIgnoreCase
            )
          )
        )
      }
  )
}

try {
  $busy = @(Get-TTcutBusyProcess)
  foreach ($item in $busy) {
    if ($item.Name -ieq 'TTcut.exe') {
      $process = Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue
      if ($process -and $process.MainWindowHandle -ne 0) {
        [void]$process.CloseMainWindow()
      }
    }
  }

  if ($busy.Count -gt 0) {
    Start-Sleep -Milliseconds 1500
  }

  $busy = @(Get-TTcutBusyProcess)
  foreach ($item in $busy) {
    Stop-Process -Id $item.ProcessId -Force -ErrorAction SilentlyContinue
  }

  if ($busy.Count -gt 0) {
    Start-Sleep -Milliseconds 500
  }

  if (@(Get-TTcutBusyProcess).Count -gt 0) {
    exit 1
  }
  exit 0
} catch {
  exit 2
}
