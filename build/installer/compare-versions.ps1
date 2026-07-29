param(
  [string]$InstalledVersion,

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

  return New-Object -TypeName PSObject -Property @{
    major = $match.Groups[1].Value
    minor = $match.Groups[2].Value
    patch = $match.Groups[3].Value
    prerelease = if ($match.Groups[4].Success) { @($match.Groups[4].Value.Split('.')) } else { @() }
  }
}

function Compare-NumericString {
  param([string]$Left, [string]$Right)

  if ($Left.Length -lt $Right.Length) { return -1 }
  if ($Left.Length -gt $Right.Length) { return 1 }
  return [string]::CompareOrdinal($Left, $Right)
}

function Compare-SemVerIdentifier {
  param([string]$Left, [string]$Right)

  $leftNumeric = $Left -match '^(0|[1-9]\d*)$'
  $rightNumeric = $Right -match '^(0|[1-9]\d*)$'
  if ($leftNumeric -and $rightNumeric) {
    return Compare-NumericString $Left $Right
  }
  if ($leftNumeric) { return -1 }
  if ($rightNumeric) { return 1 }
  return [string]::CompareOrdinal($Left, $Right)
}

function Compare-SemVer {
  param($Left, $Right)

  foreach ($part in @('major', 'minor', 'patch')) {
    $comparison = Compare-NumericString $Left.$part $Right.$part
    if ($comparison -ne 0) { return $comparison }
  }

  $leftPrerelease = @($Left.prerelease | Where-Object { $null -ne $_ })
  $rightPrerelease = @($Right.prerelease | Where-Object { $null -ne $_ })
  if ($leftPrerelease.Count -eq 0 -and $rightPrerelease.Count -eq 0) { return 0 }
  if ($leftPrerelease.Count -eq 0) { return 1 }
  if ($rightPrerelease.Count -eq 0) { return -1 }

  $count = [Math]::Min($leftPrerelease.Count, $rightPrerelease.Count)
  for ($index = 0; $index -lt $count; $index += 1) {
    $comparison = Compare-SemVerIdentifier $leftPrerelease[$index] $rightPrerelease[$index]
    if ($comparison -ne 0) { return $comparison }
  }
  return $leftPrerelease.Count.CompareTo($rightPrerelease.Count)
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
