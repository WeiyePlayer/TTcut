# TTcut v1.3.6

[简体中文](https://github.com/WeiyePlayer/TTcut/blob/v1.3.6/docs/release-notes-v1.3.6.md) | **English**

`v1.3.6` is a stable update for Windows x64 and macOS 15+ on Apple Silicon. It expands custom timeline editing and fixes analysis-boundary failures on both platforms; Windows additionally places the analysis models, runtime, and video tools inside the full installer.

## Windows analysis runtime

- The full installer bundles the BlurBall and table-analysis ONNX models, Python 3.12, ONNX Runtime DirectML/CPU, and pinned x264 FFmpeg/FFprobe binaries. Model and media-component downloads or imports are no longer required after setup.
- DirectML is preferred when supported. If a full-analysis run fails, its partial output is discarded and analysis restarts from frame zero on CPU instead of combining incomplete results from two providers.
- Full analysis remains frame-by-frame and contains no `temporal_stride` or interpolated-frame implementation. Frozen CPU/DirectML comparisons produced exactly 56 rallies/259 bounces and 16 rallies/69 bounces on two real videos. This evidence applies to those samples only and does not establish universal equivalence across devices and videos.

## Custom cutting and timeline

- Restored the Multi-select menu for selecting all rallies or filtering by a minimum bounce count from 1 to 10. Older continuous-motion records without bounce metadata show an explicit reanalysis prompt.
- Shared boundaries select the left clip end or right clip start from drag direction, while the playhead hit target no longer blocks the clip track.
- Added an independent current editing rally. Inactive clips are light blue, the playhead snaps within 8 pixels of a boundary, and `A`/`D` edit the current clip's left or right boundary, including add mode.

## Analysis and video fixes

- Automatic table calibration retries from an earlier frame when OpenCV seeks past the requested timestamp.
- Overlapping hybrid rally intervals are normalized and bounce counts recalculated before strict validation. A validated Worker timeline is preserved when FFprobe reports a slightly shorter HEVC duration.
- Compatible x264 output now uses a non-JPEG limited-range pixel format to avoid incorrect range handling.
- Component-integrity messaging now distinguishes a failed check from the normal built-in state.

## macOS platform notes

- macOS continues to use its bundled native Core ML analysis and media runtime, retaining continuous-motion rally recognition and separate bounce counting. It does not use the Windows ONNX Runtime DirectML/CPU path.
- Bounce-count multi-selection, shared-boundary dragging, current-rally editing, playhead snapping, and `A`/`D` boundary editing also apply to macOS.
- In-app updates remain disabled on macOS, so no `latest-mac.yml` is uploaded.

## Installer

- **Windows x64 · v1.3.6**: `TTcut-1.3.6-x64-Setup.exe`, the only Windows installer, containing the models, runtime, and video tools.
- The installer uses the pinned `CN=weiye` self-signed Authenticode certificate, an RFC 3161 timestamp, and a signed update manifest. Windows may still show Unknown publisher or SmartScreen on systems that do not trust this certificate.
- **macOS 15+ · Apple Silicon · v1.3.6**: `TTcut-1.3.6-arm64-Setup.dmg` (recommended) and `TTcut-1.3.6-arm64-Setup.zip`, with native analysis and media resources included. Intel Macs are not supported.
- macOS packages are ad-hoc signed and not notarized. If first launch is blocked, allow the app in System Settings > Privacy & Security.

## Verification

- TypeScript type checking passed. Vitest passed 439 tests across 62 files, with 24 tests across 6 files skipped by existing conditions. All 198 Python Worker regression tests passed.
- The production website build and both rendered-page tests passed.
- Packaged Windows x64 acceptance passed 10/10 checks covering the full-frame Worker, bounce-count multi-selection, shared boundaries, playhead hit testing, Windows hybrid results, and legacy history. Its deterministic UI records do not establish real-video landing accuracy.
- The official installer passed ONNX-model, minimal-Worker, DirectML/CPU-runtime, and x264-only package-boundary checks. The application, uninstaller, and outer installer carry the pinned certificate and RFC 3161 timestamps; the signed update manifest, SBOM, and SHA-256 checksums were generated.
