param(
  [string]$InstallDirectory,
  [string]$DeliveryManifestPath,
  [string]$ModelManifestPath
)

$ErrorActionPreference = 'Stop'

function Get-Sha256 {
  param([string]$Path)

  if (Get-Command Get-FileHash -ErrorAction SilentlyContinue) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  }

  $algorithm = New-Object System.Security.Cryptography.SHA256Managed
  $stream = $null
  try {
    $stream = [System.IO.File]::OpenRead($Path)
    $hash = $algorithm.ComputeHash($stream)
    return ([BitConverter]::ToString($hash)).Replace('-', '').ToLowerInvariant()
  } finally {
    if ($stream) { $stream.Dispose() }
    $algorithm.Dispose()
  }
}

function Read-Json {
  param([string]$Path)

  Add-Type -AssemblyName System.Web.Extensions
  $serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
  $serializer.MaxJsonLength = 4194304
  return $serializer.DeserializeObject((Get-Content -LiteralPath $Path -Raw))
}

function Get-ModelMap {
  param($Models)

  $map = @{}
  foreach ($model in @($Models)) {
    if ($null -eq $model -or [string]::IsNullOrEmpty([string]$model.filename)) {
      throw 'MODEL_MANIFEST_INVALID'
    }
    if ($map.ContainsKey([string]$model.filename)) {
      throw 'MODEL_MANIFEST_DUPLICATE'
    }
    $map[[string]$model.filename] = $model
  }
  return $map
}

function Test-ExpectedModel {
  param(
    [string]$Path,
    [int64]$ExpectedBytes,
    [string]$ExpectedSha256
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  if ((Get-Item -LiteralPath $Path -ErrorAction Stop).Length -ne $ExpectedBytes) { return $false }
  return (Get-Sha256 $Path) -eq $ExpectedSha256
}

function Invoke-ModelDownload {
  param(
    [string]$Url,
    [string]$Destination
  )

  $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
  if ($curl) {
    & $curl.Source --fail --location --max-redirs 5 --proto '=https' --proto-redir '=https' --connect-timeout 20 --retry 5 --retry-delay 2 --retry-max-time 180 --retry-all-errors --output $Destination --silent --show-error --user-agent 'TTcut-online-installer/1.2.9' $Url
    if ($LASTEXITCODE -ne 0) { throw 'MODEL_DOWNLOAD_FAILED' }
    return
  }

  $client = New-Object System.Net.WebClient
  $client.Headers.Add('User-Agent', 'TTcut-online-installer/1.2.9')
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]3072
  try {
    $attempt = 0
    while ($attempt -lt 3) {
      try {
        $client.DownloadFile($Url, $Destination)
        return
      } catch {
        $attempt += 1
        if ($attempt -ge 3) { throw }
        Start-Sleep -Seconds 2
      }
    }
  } finally {
    $client.Dispose()
  }
}

try {
  if ([string]::IsNullOrEmpty($InstallDirectory) -or
      [string]::IsNullOrEmpty($DeliveryManifestPath) -or
      [string]::IsNullOrEmpty($ModelManifestPath)) {
    throw 'MODEL_INSTALL_ARGUMENTS_INVALID'
  }

  $delivery = Read-Json $DeliveryManifestPath
  $modelManifest = Read-Json $ModelManifestPath
  if ($delivery.schema_version -ne 1 -or $modelManifest.schema_version -ne 1 -or
      [string]$delivery.repository -ne 'weiye76/TTcut-runtime-assets' -or
      [string]$delivery.release_tag -ne 'models-1.0.0') {
    throw 'MODEL_DELIVERY_MANIFEST_INVALID'
  }

  $deliveryModels = Get-ModelMap $delivery.models
  $expectedModels = Get-ModelMap $modelManifest.models
  if ($deliveryModels.Count -ne 2 -or $expectedModels.Count -ne 2) { throw 'MODEL_MANIFEST_INVALID' }
  foreach ($filename in $expectedModels.Keys) {
    if (-not $deliveryModels.ContainsKey($filename)) { throw 'MODEL_DELIVERY_MISMATCH' }
    $expected = $expectedModels[$filename]
    $candidate = $deliveryModels[$filename]
    if ([string]$candidate.model_id -ne [string]$expected.model_id -or
        [int64]$candidate.size_bytes -ne [int64]$expected.size_bytes -or
        [string]$candidate.sha256 -ne [string]$expected.sha256) {
      throw 'MODEL_DELIVERY_MISMATCH'
    }
    $uri = New-Object System.Uri([string]$candidate.url)
    $requiredPath = "/weiye76/TTcut-runtime-assets/releases/download/models-1.0.0/$filename"
    if ($uri.Scheme -ne 'https' -or $uri.Host -ne 'gitee.com' -or $uri.AbsolutePath -ne $requiredPath) {
      throw 'MODEL_DELIVERY_URL_INVALID'
    }
  }

  $modelDirectory = Join-Path $InstallDirectory 'resources\resources\models'
  New-Item -ItemType Directory -Force -Path $modelDirectory | Out-Null
  $backups = @()
  try {
    foreach ($filename in @($expectedModels.Keys | Sort-Object)) {
      $expected = $expectedModels[$filename]
      $candidate = $deliveryModels[$filename]
      $target = Join-Path $modelDirectory $filename
      if (Test-ExpectedModel $target ([int64]$expected.size_bytes) ([string]$expected.sha256)) { continue }

      $temporary = "$target.download"
      $backup = "$target.backup"
      Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
      Invoke-ModelDownload ([string]$candidate.url) $temporary
      if (-not (Test-ExpectedModel $temporary ([int64]$expected.size_bytes) ([string]$expected.sha256))) {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        throw "MODEL_HASH_MISMATCH:$filename"
      }

      $hadPrevious = Test-Path -LiteralPath $target -PathType Leaf
      if ($hadPrevious) { Move-Item -LiteralPath $target -Destination $backup -Force }
      try {
        Move-Item -LiteralPath $temporary -Destination $target -Force
      } catch {
        if ($hadPrevious -and (Test-Path -LiteralPath $backup -PathType Leaf)) {
          Move-Item -LiteralPath $backup -Destination $target -Force
        }
        throw
      }
      $backups += New-Object PSObject -Property @{ target = $target; backup = $backup; had_previous = $hadPrevious }
    }
  } catch {
    for ($index = $backups.Count - 1; $index -ge 0; $index -= 1) {
      $entry = $backups[$index]
      Remove-Item -LiteralPath $entry.target -Force -ErrorAction SilentlyContinue
      if ($entry.had_previous -and (Test-Path -LiteralPath $entry.backup -PathType Leaf)) {
        Move-Item -LiteralPath $entry.backup -Destination $entry.target -Force -ErrorAction SilentlyContinue
      }
    }
    throw
  }
  foreach ($entry in $backups) {
    Remove-Item -LiteralPath $entry.backup -Force -ErrorAction SilentlyContinue
  }
  exit 0
} catch {
  Write-Error $_
  exit 1
}
