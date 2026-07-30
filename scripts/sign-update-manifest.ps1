param(
  [Parameter(Mandatory = $true)]
  [string]$ManifestPath,

  [Parameter(Mandatory = $true)]
  [string]$SignaturePath,

  [ValidatePattern('^[A-Fa-f0-9]{40}$')]
  [string]$CertificateThumbprint = '',

  [string]$CertificatePfxPath = '',

  [string]$CertificatePfxPassword = ''
)

$ErrorActionPreference = 'Stop'
$resolvedManifest = (Resolve-Path -LiteralPath $ManifestPath -ErrorAction Stop).Path
$resolvedSignature = [System.IO.Path]::GetFullPath($SignaturePath)
$signatureDirectory = [System.IO.Path]::GetDirectoryName($resolvedSignature)
if (-not (Test-Path -LiteralPath $signatureDirectory -PathType Container)) {
  throw 'The update signature output directory does not exist.'
}
if ($resolvedManifest -eq $resolvedSignature) {
  throw 'The update signature cannot overwrite its manifest.'
}
if (Test-Path -LiteralPath $resolvedSignature) {
  throw 'The update signature output already exists.'
}

$usingStore = -not [string]::IsNullOrWhiteSpace($CertificateThumbprint)
$usingPfx = -not [string]::IsNullOrWhiteSpace($CertificatePfxPath)
if ($usingStore -eq $usingPfx) {
  throw 'Select exactly one update-manifest signing certificate source.'
}

$certificate = $null
$disposeCertificate = $false
$rsa = $null
try {
  if ($usingStore) {
    $normalizedRequestedThumbprint = $CertificateThumbprint.Replace(' ', '').ToUpperInvariant()
    $certificate = Get-Item -LiteralPath "Cert:\CurrentUser\My\$normalizedRequestedThumbprint" -ErrorAction Stop
  } else {
    $resolvedPfx = (Resolve-Path -LiteralPath $CertificatePfxPath -ErrorAction Stop).Path
    $certificate = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2
    $certificate.Import(
      $resolvedPfx,
      $CertificatePfxPassword,
      [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet
    )
    $disposeCertificate = $true
  }

  $codeSigningEku = @(
    $certificate.EnhancedKeyUsageList |
      Where-Object { [string]$_.ObjectId -eq '1.3.6.1.5.5.7.3.3' }
  )
  if (
    $certificate.Subject -ne 'CN=weiye' -or
    -not $certificate.HasPrivateKey -or
    $codeSigningEku.Count -eq 0
  ) {
    throw 'The update manifest requires a CN=weiye code-signing certificate with a private key.'
  }

  $normalizedThumbprint = $certificate.Thumbprint.Replace(' ', '').ToUpperInvariant()
  $manifestBytes = [System.IO.File]::ReadAllBytes($resolvedManifest)
  if ($manifestBytes.Length -eq 0 -or $manifestBytes.Length -gt 65536) {
    throw 'The update manifest has an invalid size.'
  }
  $manifest = [System.Text.Encoding]::UTF8.GetString($manifestBytes) | ConvertFrom-Json
  if (
    [int]$manifest.schema_version -ne 1 -or
    [string]$manifest.app_id -ne 'com.weiye.ttcut' -or
    [string]$manifest.artifact.authenticode.subject -ne $certificate.Subject -or
    [string]$manifest.artifact.authenticode.thumbprint -ne $normalizedThumbprint
  ) {
    throw 'The update manifest does not match the selected signing certificate.'
  }

  $rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($certificate)
  if ($null -eq $rsa) {
    throw 'The update manifest certificate does not expose an RSA private key.'
  }
  $signature = $rsa.SignData(
    $manifestBytes,
    [System.Security.Cryptography.HashAlgorithmName]::SHA256,
    [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
  )
  if (-not $rsa.VerifyData(
    $manifestBytes,
    $signature,
    [System.Security.Cryptography.HashAlgorithmName]::SHA256,
    [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
  )) {
    throw 'The generated update manifest signature failed its local verification.'
  }

  $envelope = [ordered]@{
    schema_version = 1
    algorithm = 'RSA-SHA256'
    key_id = $normalizedThumbprint
    signature = [Convert]::ToBase64String($signature)
  }
  $source = ($envelope | ConvertTo-Json) + [Environment]::NewLine
  $partialPath = "$resolvedSignature.partial"
  $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($partialPath, $source, $utf8WithoutBom)
  Move-Item -LiteralPath $partialPath -Destination $resolvedSignature
  Write-Output "Signed update manifest: $resolvedSignature"
} finally {
  if ($null -ne $rsa) {
    $rsa.Dispose()
  }
  if ($disposeCertificate -and $null -ne $certificate) {
    $certificate.Dispose()
  }
}
