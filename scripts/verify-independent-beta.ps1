param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,
  [string]$InstallRoot = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'TTcut-Beta-Verification')
)

$ErrorActionPreference = 'Stop'
$setup = [IO.Path]::GetFullPath($InstallerPath)
$verifyRoot = [IO.Path]::GetFullPath($InstallRoot)
$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$defaultVerificationRoot = [IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'TTcut-Beta-Verification'))
$betaData = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'TTcut-Beta'

if ($verifyRoot -ne $defaultVerificationRoot -and
    -not $verifyRoot.StartsWith(($workspaceRoot + [IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase)) {
  throw "Verification target must be the dedicated local target or stay inside the workspace: $verifyRoot"
}
if (Test-Path -LiteralPath $verifyRoot) {
  throw "Verification target already exists: $verifyRoot"
}

function Get-StableSnapshot {
  $layout = Get-ItemProperty -LiteralPath 'HKCU:\Software\TTcut\Install' -ErrorAction SilentlyContinue
  $uninstall = Get-ChildItem -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue |
    ForEach-Object {
      $value = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue
      if ($value.DisplayName -like 'TTcut*' -and $value.DisplayName -notlike 'TTcut Beta*') {
        [pscustomobject]@{
          Key = $_.PSChildName
          DisplayName = $value.DisplayName
          DisplayVersion = $value.DisplayVersion
          InstallLocation = $value.InstallLocation
          UninstallString = $value.UninstallString
        }
      }
    }
  [pscustomobject]@{
    Layout = if ($layout) {
      [pscustomobject]@{
        InstallRoot = $layout.InstallRoot
        DesktopShortcut = $layout.DesktopShortcut
        LayoutVersion = $layout.LayoutVersion
        PreservedDataRoot = $layout.PreservedDataRoot
      }
    } else { $null }
    Uninstall = @($uninstall)
  }
}

$before = Get-StableSnapshot | ConvertTo-Json -Depth 5 -Compress
$install = Start-Process -FilePath $setup -ArgumentList @('/S', ('/D=' + $verifyRoot)) -WindowStyle Hidden -Wait -PassThru
if ($install.ExitCode -ne 0) { throw "Beta installer exited $($install.ExitCode)" }

$exe = Join-Path $verifyRoot 'TTcut Beta.exe'
$uninstaller = Join-Path $verifyRoot 'Uninstall TTcut Beta.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw "Installed Beta executable missing: $exe" }
if (Test-Path -LiteralPath (Join-Path $verifyRoot 'TTcut.exe')) { throw 'Stable executable name appeared in Beta installation' }
if (Test-Path -LiteralPath (Join-Path $verifyRoot 'resources\app-update.yml')) { throw 'Beta installation contains an updater configuration' }

$betaRegistration = @(Get-ChildItem -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' |
  ForEach-Object {
    $value = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue
    if ($value.DisplayName -like 'TTcut Beta*') {
      [pscustomobject]@{
        Key = $_.PSChildName
        DisplayName = $value.DisplayName
        InstallLocation = $value.InstallLocation
        UninstallString = $value.UninstallString
      }
    }
  })
if ($betaRegistration.Count -ne 1) { throw "Expected one Beta uninstall registration, found $($betaRegistration.Count)" }

$betaApp = Start-Process -FilePath $exe -ArgumentList '--disable-gpu' -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 10
$alive = Get-Process -Id $betaApp.Id -ErrorAction SilentlyContinue
$betaProcesses = @(Get-CimInstance Win32_Process | Where-Object {
  $_.ExecutablePath -and $_.ExecutablePath.StartsWith($verifyRoot, [StringComparison]::OrdinalIgnoreCase)
})
$betaDataCreated = Test-Path -LiteralPath $betaData
foreach ($process in $betaProcesses) {
  Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
}
for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
  $remaining = @(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.StartsWith($verifyRoot, [StringComparison]::OrdinalIgnoreCase)
  })
  if ($remaining.Count -eq 0) { break }
  Start-Sleep -Milliseconds 500
}
if ($remaining.Count -ne 0) { throw 'Beta processes did not exit before uninstall verification' }

$uninstall = Start-Process -FilePath $uninstaller -ArgumentList @('/currentuser', '/S') -WindowStyle Hidden -Wait -PassThru
if ($uninstall.ExitCode -ne 0) { throw "Beta uninstaller exited $($uninstall.ExitCode)" }
Start-Sleep -Seconds 2

$after = Get-StableSnapshot | ConvertTo-Json -Depth 5 -Compress
$betaRegistrationAfter = @(Get-ChildItem -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue |
  ForEach-Object {
    $value = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue
    if ($value.DisplayName -like 'TTcut Beta*') { $value.DisplayName }
  })

$resolvedBetaData = [IO.Path]::GetFullPath($betaData)
$expectedBetaData = [IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'TTcut-Beta'))
if ($resolvedBetaData -ne $expectedBetaData) { throw 'Refusing unexpected Beta data cleanup path' }
if (Test-Path -LiteralPath $betaData) {
  Remove-Item -LiteralPath $betaData -Recurse -Force
}

[pscustomobject]@{
  InstallerExit = $install.ExitCode
  InstalledExe = $exe
  AppStayedRunning = [bool]$alive
  BetaProcessCount = $betaProcesses.Count
  BetaDataCreated = $betaDataCreated
  BetaRegistration = $betaRegistration
  StableRegistrationUnchanged = ($before -eq $after)
  UninstallerExit = $uninstall.ExitCode
  BetaRegistrationRemoved = ($betaRegistrationAfter.Count -eq 0)
  InstallDirectoryRemoved = (-not (Test-Path -LiteralPath $verifyRoot))
  TestDataRemoved = (-not (Test-Path -LiteralPath $betaData))
} | ConvertTo-Json -Depth 5 -Compress
