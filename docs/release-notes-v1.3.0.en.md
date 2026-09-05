# TTcut v1.3.0

[简体中文](release-notes-v1.3.0.md) | **English**

`v1.3.0` is a stable TTcut release. It improves Continuous motion and automatic calibration.

## Continuous motion

- Continuous motion is now the default rally-recognition method. Bounce events remain available in Settings.
- Continuity handling is improved for short rallies, vertical movement, and sparse tracks, reducing cases where valid rallies are cut short or filtered out.
- Detection and separation of slow between-rally passes, pauses, waiting, and ball-retrieval footage are improved. Rally boundaries continue to come from actual visible tracks.
- Highlights use duration tiers with Continuous motion. History and the custom timeline continue to present information according to the recognition method stored in each analysis result.

## Automatic calibration

- Automatic calibration samples table candidates at 11 points across the video, reducing reliance on any single obstructed or distracting frame.
- Stable candidates are clustered across time and evaluated against consistent table geometry. Only results with sufficient geometric support are accepted.
- Manual calibration accepts the four table corners in any order, draws their outline when complete, and keeps every point directly adjustable.

## Installers

- The draft Release provides both a full installer and an online installer. The online installer downloads and verifies required runtime resources during installation and needs an active connection; the full installer supports one-step setup.
- The installers continue to use the pinned `CN=weiye` self-signed Authenticode certificate, RFC 3161 timestamping, and a signed update manifest. Windows systems that do not trust the certificate may still show Unknown Publisher or SmartScreen warnings.

## Scope

- Continuous motion has regression coverage on reviewed samples, but those samples do not establish one universal accuracy rate for every camera angle, image quality, or scene.
- Automatic calibration can still be affected by severe occlusion, similar-looking tables in the background, blurred footage, or videos that cannot seek reliably. Manual calibration remains available when automatic calibration fails.

## Verification

- TypeScript type checking passed. Vitest passed 270 tests across 47 files, with 3 files and 17 tests conditionally skipped.
- The Python Worker passed 120 tests. The website production build and 2 rendered-page tests passed.
- Real Electron E2E passed 10 tests with 1 conditionally skipped, covering default Continuous motion analysis, automatic calibration, unordered manual calibration, batch recovery, export, and preview.
- Both installers passed fixed-certificate signing, signed update metadata, installation-structure, and runtime-resource delivery-boundary checks.
