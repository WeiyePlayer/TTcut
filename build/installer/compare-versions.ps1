param(
  [Parameter(Mandatory = $true)]
  [string]$InstalledVersion,

  [Parameter(Mandatory = $true)]
  [string]$CandidateVersion
)

$ErrorActionPreference = 'Stop'

function ConvertFrom-SemVer {
  param([string]$Value)

  $match = [regex]::Match(
    $Value,
    '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$'
  )
  if (-not $match.Success) {
    return $null
  }

  return [pscustomobject]@{
    major = [System.Numerics.BigInteger]::Parse($match.Groups[1].Value)
    minor = [System.Numerics.BigInteger]::Parse($match.Groups[2].Value)
    patch = [System.Numerics.BigInteger]::Parse($match.Groups[3].Value)
    prerelease = if ($match.Groups[4].Success) { @($match.Groups[4].Value.Split('.')) } else { @() }
  }
}

function Compare-SemVerIdentifier {
  param([string]$Left, [string]$Right)

  $leftNumeric = $Left -match '^(0|[1-9]\d*)$'
  $rightNumeric = $Right -match '^(0|[1-9]\d*)$'
  if ($leftNumeric -and $rightNumeric) {
    return [System.Numerics.BigInteger]::Compare(
      [System.Numerics.BigInteger]::Parse($Left),
      [System.Numerics.BigInteger]::Parse($Right)
    )
  }
  if ($leftNumeric) { return -1 }
  if ($rightNumeric) { return 1 }
  return [string]::CompareOrdinal($Left, $Right)
}

function Compare-SemVer {
  param($Left, $Right)

  foreach ($part in @('major', 'minor', 'patch')) {
    $comparison = [System.Numerics.BigInteger]::Compare($Left.$part, $Right.$part)
    if ($comparison -ne 0) { return $comparison }
  }

  if ($Left.prerelease.Count -eq 0 -and $Right.prerelease.Count -eq 0) { return 0 }
  if ($Left.prerelease.Count -eq 0) { return 1 }
  if ($Right.prerelease.Count -eq 0) { return -1 }

  $count = [Math]::Min($Left.prerelease.Count, $Right.prerelease.Count)
  for ($index = 0; $index -lt $count; $index += 1) {
    $comparison = Compare-SemVerIdentifier $Left.prerelease[$index] $Right.prerelease[$index]
    if ($comparison -ne 0) { return $comparison }
  }
  return $Left.prerelease.Count.CompareTo($Right.prerelease.Count)
}

try {
  $installed = ConvertFrom-SemVer $InstalledVersion
  $candidate = ConvertFrom-SemVer $CandidateVersion
  if ($null -eq $candidate) { exit 3 }
  if ($null -eq $installed) { exit 0 }
  if ((Compare-SemVer $candidate $installed) -lt 0) { exit 2 }
  exit 0
} catch {
  exit 3
}
