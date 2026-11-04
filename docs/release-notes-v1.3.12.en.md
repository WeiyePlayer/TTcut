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
