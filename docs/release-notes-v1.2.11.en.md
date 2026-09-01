# TTcut v1.2.11

[简体中文](release-notes-v1.2.11.md) | **English**

`v1.2.11` is a stable TTcut 1.2 release. It adds an optional rally-recognition method and fixes several issues in the continuous-visibility flow and runtime-resource installation.

## Rally recognition method

- Settings now provides Rally recognition method. The default, Bounce events, retains existing behavior; Continuous visibility is for footage where bounce events are insufficient but the ball remains visible for a continuous period.
- Continuous visibility always uses full analysis, not the high-precision two-stage flow. Highlights are filtered by duration tiers rather than a bounce-based count.
- Each analysis result stores the method it actually used. History and the custom timeline present count or duration information from their own result, not the current setting.

## Fixes

- Fixed missed or incorrectly filtered continuous-visibility rallies in end segments, short clear rallies, and footage where the ball is small.
- Fixed an occasional post-extraction file-handle conflict during runtime-resource installation that could prevent a staging directory from being renamed.

## Installers

- The Release provides both a full installer and an online installer. The online installer downloads and verifies required runtime resources during installation and needs an active connection; the full installer is for a one-step setup.

## Scope

- This release does not claim a single quantified accuracy percentage. Results still depend on video quality, calibration, the selected rally-recognition method, and the local machine.
- The installer continues to use the pinned `CN=weiye` self-signed Authenticode certificate, RFC 3161 timestamping, and a signed update manifest. Windows systems that do not trust the certificate may still show Unknown Publisher or SmartScreen warnings.

## Verification

- `npm run typecheck` passed; serial Vitest: 46 files and 255 tests passed, with 3 files and 17 tests conditionally skipped.
- Worker tests: 85 passed; website build and rendered-HTML tests: 2 passed.
- The formal build will verify that the full installer contains only `blurball_best.pt` and the table weight. Local TrackNet weights are not distributed, and packaged builds do not enable local TrackNet configuration.
- Both installers will complete fixed `CN=weiye` certificate signing, update-manifest signing, installer-structure validation, and model-delivery boundary checks.
