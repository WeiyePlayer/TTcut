# TTcut v1.1.0

[简体中文](release-notes-v1.1.0.md) | **English**

`v1.1.0` is the first stable release in the TTcut 1.1 line. It completes the analysis-performance, automatic-calibration, export-reliability, and installation work introduced during the beta.

## Main features

- Automatic table calibration by default, with manual four-corner calibration as a fallback.
- Serial batch processing for multiple MP4 files; one failed item does not stop the remaining queue.
- Bundled rally-analysis and table-recognition models with size and SHA-256 verification before packaging.
- Backward-compatible local analysis history with completion and output information.
- In-app update checks, background downloads, and restart-to-install.
- Optional `libx264` support with automatic fallback to OpenH264.

## Stable-release improvements

- A fixed analysis ROI is derived from each video's table calibration. Only TrackNet input is cropped; trajectories, rally timing, and exports remain in source-video coordinates.
- The default ROI model-input profile uses a 1.25x multiplier and 8-pixel stride alignment.
- CUDA analysis uses a bounded pipeline with tighter frame buffering and clearer progress across calibration, model loading, analysis, and result preparation.
- Metadata-driven sample seeking reduces repeated decoding during automatic calibration on long videos while retaining multi-frame consistency checks.
- AAC timestamp handling is repaired for segmented export, improving consistency across stream copy, joining, and final-duration validation.
- The former test-only intermediate dialog is removed from analysis; structured errors and recovery actions remain.

## Installation and updates

- The Windows x64 release now uses an assisted NSIS installer with an installation-root choice and optional desktop shortcut. A Start menu shortcut is always created.
- Application files are stored under `<root>\app`; large runtimes and components are stored under `<root>\data\components` and retained across upgrades.
- The installer recognises and migrates the legacy layout. Stable builds use the `latest` update channel.
- Download `TTcut-1.1.0-x64-Setup.exe` and verify it with the included `SHA256SUMS.txt`.

## Release verification

- TypeScript, Vitest, and focused Worker Python tests pass.
- Release verification covers bundled models, the minimal Worker, Renderer isolation, Electron fuses, NSIS update metadata, and the public asset contract.
- Official artifacts verify Authenticode signatures and timestamps on the packaged application, uninstaller, and outer installer.

TTcut uploads no videos, analysis results, or history. Bundled models work offline; the Python/PyTorch runtime and FFmpeg media component still require an internet connection during first-time installation.
