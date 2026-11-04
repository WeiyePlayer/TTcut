# TTcut v1.3.4

[简体中文](https://github.com/WeiyePlayer/TTcut/blob/v1.3.4/docs/release-notes-v1.3.4.md) | **English**

`v1.3.4` is a stable update for Windows x64 and macOS 15+ on Apple Silicon. Both platforms gain custom-cut playback modes, timeline zoom, playback recovery, and runtime diagnostics. Windows also gives users control over when updates are downloaded and installed and adds stronger GPU-inference diagnostics.

## Custom playback and timeline

- Custom cutting now switches between Source playback and Rally playback. Rally playback follows the selected timeline clips in time order, skips gaps, and applies selection or boundary changes immediately.
- Clicking an unselected rally temporarily previews it without changing the selection or export. Playback mode affects only the monitor and does not change analysis results, history, or export formats.
- A Zoom video track tool adds pointer-centered mouse-wheel zoom over the ruler and clip track. The existing Ctrl/Command + wheel shortcut remains available.

## Windows in-app updates

- TTcut now prompts before downloading an available update. Users can choose Update now, Remind later, or Skip this version.
- After the package is downloaded and verified, users can restart immediately or later. A normal quit does not install the update automatically.
- Skipped versions are recorded locally. Newer versions still prompt, and a manual check from Settings ignores the skip record so the choice can be revisited.

## Playback recovery and runtime diagnostics

- Fixed clicked playback targets being overwritten while metadata loaded or a compatible proxy was prepared, and preserved the latest play or pause intent when playback requests are interrupted.
- Fully stalled playback with no time advancement can now request compatible-preview recovery. Normally decodable media still plays directly, and analysis and export source files are unchanged.
- Windows BlurBall uses FP32 directly on GPUs with known FP16 risk. Other CUDA devices retry and remain on FP32 after NaN/Inf output. Persistently invalid output now fails explicitly instead of being silently saved as a successful zero-rally result.
- Windows logs now include the actual GPU, precision, batch size, and detection statistics. Both platforms add process-exit details and retain local crash dumps without upload to support diagnosis of native failures.

## Known boundaries

- The GTX 1660 Super zero-rally report is supported by public compatibility evidence and fault-injection tests, but has not been closed out on the user's actual GPU. This release does not claim an on-device confirmation.
- The root cause of the historically reported crash near the end of export is still unknown. This release adds export-stage, process-exit, and local-dump diagnostics; it does not claim that unknown native crash is fixed.

## Installer

- **Windows x64 · v1.3.4**: `TTcut-1.3.4-x64-Setup.exe`, a full installer containing the required runtime resources for a one-step setup.
- The installer uses the pinned `CN=weiye` self-signed Authenticode certificate, an RFC 3161 timestamp, and a signed update manifest. Windows may still show Unknown publisher or SmartScreen on systems that do not trust this certificate.
- **macOS 15+ · Apple Silicon · v1.3.4**: `TTcut-1.3.4-arm64-Setup.dmg` (recommended) and `TTcut-1.3.4-arm64-Setup.zip`, with bundled native Core ML analysis and media-processing runtimes. Intel Macs are not supported.
- The macOS packages are ad-hoc signed and not notarized. If macOS blocks the first launch, allow the app in System Settings > Privacy & Security. In-app updating is currently unavailable on macOS.

## Verification

- TypeScript type checking passed. Vitest passed 409 tests across 61 files, with 25 tests across 6 files skipped by their existing conditions. All 222 Python regression tests passed.
- The production website build and both rendered-page tests passed.
- Packaged Windows x64 Electron checks passed 16 custom-playback cases and 4 timeline-zoom cases, including target positions and decoded-frame advancement. The packaged application startup smoke also passed.
- The full installer passed pinned-model, assisted-NSIS, installation-layout, and runtime-delivery checks. The application, uninstaller, and outer Setup carry the pinned certificate and RFC 3161 timestamps; the signed update manifest, SBOM, and SHA-256 checksums were generated.
- macOS passed TypeScript, dedicated Vitest, native Swift, Core ML model, production Electron workflow, packaged UI, arm64 bundle-signature, and DMG/ZIP delivery checks.
