# TTcut v1.1.2

## Automatic update fix

- Adds a release-key-signed update manifest that binds the version, channel,
  installer filename, byte length, and SHA-512 digest.
- Pins the release certificate public key inside the application. A
  self-signed installer whose only trust failure is `UntrustedRoot` is accepted
  only after the manifest signature, installer digest, certificate fingerprint,
  and RFC 3161 timestamp all verify.
- Rejects any mismatch in the installer, manifest, detached signature, or
  publisher identity.
- Replaces the raw certificate JSON in Settings with a concise message and a
  manual-download button while retaining full diagnostics in the log.

## Upgrading from an older version

The old updater in v1.1.0 and v1.1.1 rejects a self-signed installer before the
new application code can run. Install `TTcut-1.1.2-x64-Setup.exe` manually once
from the official Release page. The existing Installation Root, Component
Store, and user data remain in place.

Automatic updates resume from v1.1.2 for later releases carrying a valid signed
update manifest.

## Release assets

An official Release must include Setup, its blockmap, `latest.yml`,
`update-manifest.json`, `update-manifest.json.sig`, `SHA256SUMS.txt`, and the
SBOM. Do not publish a Release that is missing either signed-update asset.
