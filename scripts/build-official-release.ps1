param(
  [ValidatePattern('^[A-Fa-f0-9]{40,64}$')]
  [string]$CertificateThumbprint = '',

  [ValidatePattern('^https?://')]
  [string]$TimestampServer = 'http://timestamp.digicert.com'
)

$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$node = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) {
  $node = (Get-Command node.exe -ErrorAction Stop).Source
}

$signTool = Get-ChildItem -LiteralPath 'C:\Program Files (x86)\Windows Kits\10\bin' -Filter signtool.exe -Recurse -ErrorAction Stop |
  Where-Object { $_.FullName -match '\\x64\\signtool\.exe$' } |
  Sort-Object FullName -Descending |
  Select-Object -First 1
if (-not $signTool) { throw 'Windows SDK x64 SignTool was not found.' }

function Test-CodeSigningCertificate($Certificate) {
  return $Certificate.HasPrivateKey -and
    $Certificate.NotAfter -gt (Get-Date).AddDays(30) -and
    @($Certificate.EnhancedKeyUsageList | Where-Object { [string]$_.ObjectId -eq '1.3.6.1.5.5.7.3.3' }).Count -gt 0
}

if ($CertificateThumbprint) {
  $normalizedThumbprint = $CertificateThumbprint.Replace(' ', '').ToUpperInvariant()
  $certificate = Get-Item -LiteralPath "Cert:\CurrentUser\My\$normalizedThumbprint" -ErrorAction Stop
  if ($certificate.Subject -ne 'CN=weiye' -or -not (Test-CodeSigningCertificate $certificate)) {
    throw 'The requested certificate is not a usable CN=weiye code-signing certificate with a private key.'
  }
} else {
  $candidates = @(Get-ChildItem -LiteralPath 'Cert:\CurrentUser\My' |
    Where-Object { $_.Subject -eq 'CN=weiye' -and (Test-CodeSigningCertificate $_) } |
    Sort-Object NotAfter -Descending)
  if ($candidates.Count -gt 1) {
    throw 'Multiple usable CN=weiye certificates exist. Pass -CertificateThumbprint explicitly.'
  }
  if ($candidates.Count -eq 1) {
    $certificate = $candidates[0]
  } else {
    $certificate = New-SelfSignedCertificate `
      -Type CodeSigningCert `
      -Subject 'CN=weiye' `
      -FriendlyName 'TTcut self-signed Authenticode' `
      -CertStoreLocation 'Cert:\CurrentUser\My' `
      -KeyAlgorithm RSA `
      -KeyLength 3072 `
      -HashAlgorithm SHA256 `
      -KeyExportPolicy NonExportable `
      -KeyUsage DigitalSignature `
      -NotAfter (Get-Date).AddYears(3)
  }
  $normalizedThumbprint = $certificate.Thumbprint.Replace(' ', '').ToUpperInvariant()
}

$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) "ttcut-signing-$PID-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $temporaryRoot | Out-Null
$publicCertificate = Join-Path $temporaryRoot 'weiye.cer'
Export-Certificate -Cert $certificate -FilePath $publicCertificate -Type CERT | Out-Null
$rootStore = [System.Security.Cryptography.X509Certificates.X509Store]::new(
  [System.Security.Cryptography.X509Certificates.StoreName]::Root,
  [System.Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser
)
$rootStore.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
try {
  $existingRootCertificates = @($rootStore.Certificates | Where-Object { $_.Thumbprint -eq $normalizedThumbprint })
  $temporaryTrustAdded = $existingRootCertificates.Count -eq 0
} finally {
  $rootStore.Close()
}

function Invoke-NodeScript([string]$RelativePath) {
  $script = Join-Path $projectRoot $RelativePath
  & $node $script
  if ($LASTEXITCODE -ne 0) { throw "$RelativePath failed with exit code $LASTEXITCODE." }
}

try {
  if ($temporaryTrustAdded) {
    $rootStore.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
    try { $rootStore.Add($certificate) } finally { $rootStore.Close() }
  }
  $env:TTCUT_OFFICIAL_RELEASE = '1'
  $env:TTCUT_PUBLIC_RC = '0'
  $env:TTCUT_PUBLISHER_NAME = 'weiye'
  $env:WINDOWS_CERTIFICATE_THUMBPRINT = $normalizedThumbprint
  $env:WINDOWS_SIGNTOOL_PATH = $signTool.FullName
  $env:WINDOWS_TIMESTAMP_SERVER = $TimestampServer
  Remove-Item Env:\WINDOWS_CERTIFICATE_FILE -ErrorAction SilentlyContinue
  Remove-Item Env:\WINDOWS_CERTIFICATE_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:\WINDOWS_SIGN_WITH_PARAMS -ErrorAction SilentlyContinue

  Invoke-NodeScript 'scripts\stage-worker.mjs'
  Invoke-NodeScript 'scripts\generate-release-metadata.mjs'
  Invoke-NodeScript 'scripts\make.mjs'
  Invoke-NodeScript 'scripts\verify-release.mjs'
  Invoke-NodeScript 'scripts\generate-public-release-assets.mjs'
  Invoke-NodeScript 'scripts\verify-signatures.mjs'

  Write-Output "TTcut official release assets are ready."
  Write-Output "Certificate subject: $($certificate.Subject)"
  Write-Output "Certificate thumbprint: $normalizedThumbprint"
  Write-Output "Certificate expires: $($certificate.NotAfter.ToUniversalTime().ToString('o'))"
  Write-Output "SignTool: $($signTool.FullName)"
} finally {
  if ($temporaryTrustAdded) {
    $rootStore.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
    try {
      @($rootStore.Certificates | Where-Object { $_.Thumbprint -eq $normalizedThumbprint }) |
        ForEach-Object { $rootStore.Remove($_) }
    } finally {
      $rootStore.Close()
    }
  }
  if (Test-Path -LiteralPath $temporaryRoot) {
    Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
  }
}
