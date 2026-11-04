# TTcut v1.3.12

[简体中文](https://github.com/WeiyePlayer/TTcut/blob/v1.3.12/docs/release-notes-v1.3.12.md) | **English**

## Changes

- **Windows**: if browser decoding cannot display calibration video, FFmpeg extracts the selected frame so frame selection and table annotation can continue. Frames respect display rotation, tone-map HDR for preview and use bounded dimensions without replacing original media.
- Rapid seeking prioritizes the latest request and ignores stale results. Calibration requires an available frame; extraction failures are explicit. Restricted extraction IPC and image channels retain source access controls and shutdown cleanup.
- **macOS**: update the shared calibration UI, media channel and preview-state handling. Compatible video previews remain in use; Windows-only frame fallback is not enabled. Native Core ML, source-time analysis, dynamic HDR-to-SDR export and independent XML are retained.
- BlurBall models, default sampling, rally recognition and export rules are unchanged.

## Packages

- **Windows x64 v1.3.12**: `TTcut-1.3.12-x64-Setup.exe`, including models, runtimes, native preview and video tools. The fixed self-signed `CN=weiye` certificate and timestamp remain; SmartScreen or Unknown Publisher warnings are possible.
- **macOS 15+ Apple Silicon v1.3.12**: `TTcut-1.3.12-arm64-Setup.dmg` (recommended) and `TTcut-1.3.12-arm64-Setup.zip`. Intel Macs are unsupported.
- macOS is ad-hoc signed, not notarized. If blocked on first launch, allow it in System Settings > Privacy & Security. In-app updates remain disabled; no `latest-mac.yml` is supplied.

## Verification boundaries

- The Windows draft records that unit tests, type checking and real-media/UI acceptance were not run this round as requested; official packaging checks remained enabled. This does not establish Windows functional acceptance.
- Corresponding source and license materials for the pinned Windows native-preview/libmpv build and linked dependencies remain unverified; installers and checksums do not establish completion.
- Algorithm-accuracy evaluation, actual Premiere import and Windows installation/upgrades are not repeated here. macOS ad-hoc signature checks do not imply Apple notarization.

## macOS release verification

- Type checking and 46 related regressions passed. One real-FFmpeg rotated ProRes frame-extraction test passed using the Windows probe route simulated on macOS, not a Windows machine.
- Four development-mode real Electron UI checks with native workers passed, covering four-point calibration, automatic-calibration failure recovery, batch cancellation/retry and quit cleanup.
- All 21 actual packaged-app checks passed, covering offline startup, Chinese/English UI, Core ML, 120 fps, decoded-frame advancement, HDR/VFR, history and export.
- DMG mounting, 29 arm64 native binaries, signature integrity and archive SHA-256 checks passed. macOS build source: `29f2bad38dca13c7177b5088456d2488518c13e5`, with a clean worktree recorded in the manifest. Windows draft source: `ca4f47c7ac2ba95e175d02190f79b7ea0cc2df0a`.
- Windows checksums match GitHub digests and update metadata agrees on version, installer filename and size. Windows signing/installation were not rechecked on this Mac.
- macOS DMG SHA-256: `5395e9f75b7b6832a87584069358758811f102bd627206826787423dd17e1572`.
- macOS ZIP SHA-256: `6f11dd6ae51d5c39726f44c38f425bba9673ee37975dd80ddc0905dcf9f0bbdf`.
