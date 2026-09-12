# TTcut v1.3.3

[简体中文](https://github.com/WeiyePlayer/TTcut/blob/v1.3.3/docs/release-notes-v1.3.3.md) | **English**

`v1.3.3` is a stable TTcut update for Windows x64 and macOS 15+ on Apple Silicon. It adds merged rally exports across multiple videos, improves Windows rally recognition, and fixes confirmed issues.

## New features

- Batch cutting now offers Merge into one video. Each source can use All rallies or Highlights, and TTcut cuts and joins the selected rallies into one MP4 in task order.
- Merged export normalizes differing frame sizes, orientations, frame rates, color formats, and audio tracks, then decodes the complete output before reporting success.
- Completed analyses are retained after a failed or cancelled merge, so the export can be retried without analyzing the videos again.

## Windows rally-recognition improvements

- The Windows default recognizer now combines motion trajectories with bounce evidence. Continuous-motion and bounce-event modes remain available. macOS continues to use native Core ML continuous-visibility recognition; the Windows hybrid strategy is not presented as a macOS capability.
- Refined slow returns, short reverse returns, rally endings, and off-table transfers to reduce incorrectly split, truncated, or missed rallies.
- In the real samples covered by user feedback and frozen trajectories, this update corrected two incorrect splits, one truncated ending, and one missed rally. This accuracy statement applies only to the validated samples, not every camera angle, encoding, or match condition.

## Fixes

- Improved compatible previews and analysis diagnostics when a source video cannot be played directly.
- Fixed processed-media metadata that could still reference the original path after variable-frame-rate normalization.
- Kept the merged-task list columns stable after analysis completes.

## Installers

- **Windows x64 · v1.3.3**: `TTcut-1.3.3-x64-Setup.exe`, a full installer containing the required runtime resources for a one-step setup. It uses the pinned `CN=weiye` self-signed Authenticode certificate, an RFC 3161 timestamp, and signed update manifests. Windows may still show Unknown publisher or SmartScreen on systems that do not trust this certificate.
- **macOS 15+ · Apple Silicon · v1.3.3**: `TTcut-1.3.3-arm64-Setup.dmg` (recommended) and `TTcut-1.3.3-arm64-Setup.zip`, including the native Core ML analysis and media-processing runtimes. Intel Macs are not supported.
- The macOS packages are ad-hoc signed and not Apple-notarized. If macOS blocks the first launch, allow it in System Settings > Privacy & Security. In-app updates are currently unavailable.

## Verification

- Windows release verification: TypeScript type checking passed. Vitest passed 316 tests across 54 files, with 21 tests across 4 files skipped by their existing conditions. All 185 Python regression tests passed.
- The production website build and both rendered-page tests passed.
- The merged-video workflow passed four real FFmpeg mixed-media regression cases covering different frame sizes, orientations, frame rates, VFR sources, and sources with or without audio. The packaged Electron merge, history, and preview flow also passed.
- The Windows full installer passed pinned-certificate signature checks, signed update-manifest checks, installation-structure checks, and runtime-resource delivery-boundary checks.
- macOS passed TypeScript, dedicated Vitest, native Swift, packaged Electron workflows, batch UI, arm64 bundle-signature, and DMG/ZIP delivery checks.
