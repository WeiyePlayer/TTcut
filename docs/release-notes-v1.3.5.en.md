# TTcut Windows v1.3.5

[简体中文](https://github.com/WeiyePlayer/TTcut/blob/v1.3.5/docs/release-notes-v1.3.5.md) | **English**

`v1.3.5` is a stable update for Windows x64. It adds bounce-count multi-selection for custom rallies and improves shared-boundary timeline interaction.

## Custom rally multi-selection

- The custom-cut list now has a Multi-select menu for selecting all rallies or entering a minimum bounce count from 1 to 10. Clear all remains directly available.
- Continuous-motion results now carry separate bounce-detection metadata. Windows custom cutting reuses the existing BlurBall landing results to display and filter bounce counts.
- When an older analysis has no bounce-count metadata, the filter is disabled with an explicit reanalysis prompt instead of treating missing data as zero.

## Timeline interaction fixes

- When adjacent clips share a boundary, dragging left resizes the left clip's end and dragging right resizes the right clip's start. The chosen clip stays fixed if the pointer reverses during the same gesture.
- The playhead captures dragging only over the ruler. Its red line over the track is now visual only and no longer blocks clip clicks or boundary resizing.
- Resizing shows the actual duration change while continuing to enforce neighboring-clip, minimum-duration, and video-range constraints.

## Installer

- **Windows x64 · v1.3.5**: `TTcut-1.3.5-x64-Setup.exe`, a full installer containing the required runtime resources for a one-step setup.
- The installer uses the pinned `CN=weiye` self-signed Authenticode certificate, an RFC 3161 timestamp, and a signed update manifest. Windows may still show Unknown publisher or SmartScreen on systems that do not trust this certificate.
- This GitHub Release remains a draft and no `v1.3.5` tag is pushed.

## Verification

- TypeScript type checking passed. Vitest passed 431 tests across 63 files, with 25 tests across 6 files skipped by their existing conditions. All 256 Python regression tests passed.
- The production website build and both rendered-page tests passed.
- Six packaged Windows x64 acceptance checks passed for multi-selection, bounce filtering, and adjacent-boundary timeline interaction.
- The full installer passed pinned-model, assisted-NSIS, installation-layout, and runtime-delivery checks. The application, uninstaller, and outer Setup carry the pinned certificate and RFC 3161 timestamps; the signed update manifest, SBOM, and SHA-256 checksums were generated.
