# TTcut v1.1.2

[简体中文](release-notes-v1.1.2.md) | **English**

`v1.1.2` is a stable patch in the TTcut 1.1 line. It repairs the automatic-update trust chain for self-signed installers and improves MOV, portrait-video, and post-export workflows.

## Automatic updates and release verification

- Adds a release-key-signed update manifest that binds the version, channel, installer filename, byte length, and SHA-512 digest.
- Pins the release certificate public key inside the application. A self-signed installer whose only trust failure is `UntrustedRoot` is accepted only after the manifest signature, installer digest, certificate fingerprint, and RFC 3161 timestamp all verify.
- Rejects any mismatch in the installer, manifest, detached signature, or publisher identity.
- Replaces the raw certificate JSON in Settings with a concise message and a manual-download button while retaining full diagnostics in the log.

## MOV and portrait video

- Single-video and Batch task workflows now accept both MP4 and MOV files. MOV sources are exported as MP4.
- Probing, automatic/manual calibration, and export account for rotation metadata. Manual calibration continues to use source-pixel coordinates.
- Calibration, rally, output, and history previews use contain-based fitting so portrait frames remain fully visible inside landscape cards.
- Re-encoded rotated videos are pixel-normalised and the final dimensions, orientation, and rotation metadata are validated.

## Post-export support prompt

- A non-blocking support prompt appears after a single export completes and after a started batch exhausts all currently completable tasks.
- The prompt remains visible across in-app navigation and can open the support page, be dismissed, or be suppressed for 30 days.
- The 30-day deadline is stored only on the local device. Storage failures do not interrupt exporting or dismissal.

## Upgrading from an older version

The old updater in `v1.1.0` and `v1.1.1` rejects a self-signed installer before the new application code can run. Install `TTcut-1.1.2-x64-Setup.exe` manually once from the official Release page. The existing Installation Root, Component Store, and user data remain in place.

Automatic updates resume from `v1.1.2` for later releases carrying a valid signed update manifest.

## Release assets and verification

An official Release must include Setup, its blockmap, `latest.yml`, `update-manifest.json`, `update-manifest.json.sig`, `SHA256SUMS.txt`, and the SBOM. Do not publish a Release that is missing either signed-update asset.

The official build verifies bundled models, the minimal Worker, application and installer structure, the manifest signature, installer SHA-512, and Authenticode plus RFC 3161 timestamps on the TTcut executable, uninstaller, and outer Setup.
