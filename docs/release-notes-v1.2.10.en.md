# TTcut v1.2.10

[简体中文](release-notes-v1.2.10.md) | **English**

`v1.2.10` is a stable TTcut 1.2 release. It makes constant-frame-rate re-encoding optional for variable-frame-rate video and fixes a known installation-flow issue.

## Variable-frame-rate video processing

- Settings now provides Re-encode as constant frame rate, which is off by default.
- When it is off, variable-frame-rate videos use the original media for analysis, preview, cutting, and newly created XML. No constant-frame-rate cache or fallback notice is created.
- When it is on, TTcut creates constant-frame-rate processing media after calibration and uses it for later stages. This makes cut timing more stable, with additional processing time and disk use.
- Calibration always uses the original video. When enabled preparation runs out of space, transcoding fails, or output validation fails, TTcut explains the reason and continues with the original VFR video. Cancellation and exit do not silently fall back.

## Fixes

- Fixed an installer issue where pre-install disk-space probing could incorrectly block installation in some environments.

## Installers

- The Release provides both a full installer and an online installer. The online installer downloads and verifies required runtime resources during installation and needs an active connection; the full installer is for a one-step setup.

## Scope

- This release does not claim a single quantified accuracy percentage. Results still depend on video quality, calibration, selected analysis precision, and the local machine.
- The installer continues to use the pinned `CN=weiye` self-signed Authenticode certificate, RFC 3161 timestamping, and a signed update manifest. Windows systems that do not trust the certificate may still show Unknown Publisher or SmartScreen warnings.

## Verification

- `npm run typecheck` passed; serial Vitest: 46 files and 246 tests passed, with 3 files and 17 tests conditionally skipped.
- Worker tests: 45 passed; website build and rendered-HTML tests: 2 passed.
- Both installers completed fixed `CN=weiye` certificate signing, update-manifest signing, installer-structure validation, and model-delivery boundary checks.
