# TTcut v1.3.0

[简体中文](release-notes-v1.3.0.md) | **English**

`v1.3.0` is a stable TTcut release with desktop packages for Windows x64 and macOS 15+ on Apple Silicon. The Windows build improves Continuous motion and automatic calibration; the first macOS build provides local analysis and media processing through native Core ML services.

## Windows: Continuous motion

- Continuous motion is now the default rally-recognition method. Bounce events remain available in Settings.
- Continuity handling is improved for short rallies, vertical movement, and sparse tracks, reducing cases where valid rallies are cut short or filtered out.
- Detection and separation of slow between-rally passes, pauses, waiting, and ball-retrieval footage are improved. Rally boundaries continue to come from actual visible tracks.
- Highlights use duration tiers with Continuous motion. History and the custom timeline continue to present information according to the recognition method stored in each analysis result.

## Windows: Automatic calibration

- Automatic calibration samples table candidates at 11 points across the video, reducing reliance on any single obstructed or distracting frame.
- Stable candidates are clustered across time and evaluated against consistent table geometry. Only results with sufficient geometric support are accepted.
- Manual calibration accepts the four table corners in any order, draws their outline when complete, and keeps every point directly adjustable.

## First macOS desktop release

- Uses the same Electron interface as Windows while bundled native Core ML workers perform table, ball, and media processing locally.
- The macOS interface offers both Bounce events and Continuous motion, but its native worker is not yet connected to the Continuous motion algorithm. Current analysis results use Bounce events regardless of that selection.
- Automatic calibration on macOS currently samples 5 points across the video. Manual calibration supports marking the four corners in any order and adjusting them afterward.

## Platforms and packages

- **Windows x64 · v1.3.0**: includes full and online installers. The online installer downloads and verifies required runtime resources during installation and needs an active connection; the full installer supports one-step setup.
- **macOS 15+ · Apple Silicon · v1.3.0**: includes DMG (recommended) and ZIP packages with the native Core ML analysis and media runtimes bundled. Intel Macs are not supported.
- The Windows installers continue to use the pinned `CN=weiye` self-signed Authenticode certificate, RFC 3161 timestamping, and a signed update manifest. Windows systems that do not trust the certificate may still show Unknown Publisher or SmartScreen warnings.
- The macOS package is ad-hoc signed and not Apple-notarized. If macOS blocks the first launch, allow it in System Settings > Privacy & Security. Automatic updates are not available in the current macOS build.

## Scope

- Continuous motion has regression coverage on reviewed samples, but those samples do not establish one universal accuracy rate for every camera angle, image quality, or scene.
- Automatic calibration can still be affected by severe occlusion, similar-looking tables in the background, blurred footage, or videos that cannot seek reliably. Manual calibration remains available when automatic calibration fails.
- The platforms use different analysis runtimes. Windows algorithm regression results do not establish macOS algorithm accuracy.

## Verification

- TypeScript type checking passed. Vitest passed 270 tests across 47 files, with 3 files and 17 tests conditionally skipped.
- The Python Worker passed 120 tests. The website production build and 2 rendered-page tests passed.
- Real Electron E2E passed 10 tests with 1 conditionally skipped, covering default Continuous motion analysis, automatic calibration, unordered manual calibration, batch recovery, export, and preview.
- Both installers passed fixed-certificate signing, signed update metadata, installation-structure, and runtime-resource delivery-boundary checks.
- The macOS-specific Vitest suite passed 16 tests and the native Swift suite passed 22 tests. The app also passed Apple Silicon bundle-structure, runtime-resource, code-signing, and DMG-mount checks. This verification does not establish Apple notarization or Intel Mac compatibility.
