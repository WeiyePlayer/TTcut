# TTcut v1.3.10

[简体中文](https://github.com/WeiyePlayer/TTcut/blob/v1.3.10/docs/release-notes-v1.3.10.md) | **English**

For Windows x64 and macOS 15+ on Apple Silicon: improved export fidelity, dynamic HDR handling and runtime reliability.

## Both platforms: export and preview

- HDR10/HLG or HEVC inputs export as HEVC/hvc1; other SDR inputs use H.264. Supported 8/10-bit depth, chroma, color properties and static HDR metadata are retained. Fidelity does not mean lossless encoding.
- Preserve VFR timestamps, frame durations and the last frame. Batch exports retain existing sizing, frame-rate and audio rules; incompatible color/depth/HDR contracts fail explicitly instead of silently converting to SDR.
- Fidelity-preserving Dolby Vision/HDR10+ video export remains unsupported and is rejected before export to avoid losing dynamic metadata. Unsupported bit depths also fail explicitly.
- Compatible HDR/HEVC result previews support playback and seeking without replacing original or exported files.
- Batch exports probe participating sources only; empty selections do not determine output specifications.

## Windows

- Isolate bundled Python search paths from external PYTHONHOME, PYTHONPATH, user packages and shadowing modules, retaining DirectML model validation and CPU fallback.
- Add x265 support to bundled video tools.
- Re-probe original media for legacy histories rather than using CFR caches that may have lost HDR metadata. Missing caches can recover through the original source after path/fingerprint validation, without rewriting original analysis metadata. Missing or changed sources remain protected.

## macOS

- Move dynamic HDR export restrictions out of import, calibration and analysis validation. Synthetic HDR10+ footage was tested; user originals and real Dolby Vision footage were unavailable, so support for every Dolby Vision format is not claimed.
- Log actual HDR type, bit depth, transfer characteristics and probe failures without masking original errors if logging fails.
- Retain native Core ML analysis and Swift media processing; models, recognition algorithms and default sampling settings are unchanged.

## Packages and limitations

- **Windows x64 v1.3.10**: `TTcut-1.3.10-x64-Setup.exe`, including models, runtime, native preview and video tools. Fixed self-signed `CN=weiye` Authenticode certificate and RFC 3161 timestamp; untrusted systems may show Unknown Publisher or SmartScreen.
- **macOS 15+ Apple Silicon v1.3.10**: `TTcut-1.3.10-arm64-Setup.dmg` (recommended) and `TTcut-1.3.10-arm64-Setup.zip`. Intel Macs are unsupported.
- macOS is ad-hoc signed, not notarized. If blocked on first launch, allow it in System Settings > Privacy & Security. In-app updates remain disabled; no `latest-mac.yml` is supplied.
- Corresponding source and notices for the pinned Windows libmpv build and linked dependencies, listed as pending in the Windows draft, have not been verified complete. Installer and update-check files do not satisfy or prove completion of that material.
- Windows preparation records 103 related regressions, signing/update checks and 7 real-app checks passing; see the [Windows validation record](https://github.com/WeiyePlayer/TTcut/blob/develop/docs/windows-runtime-fidelity-validation-2026-10-16.md). This macOS release does not rerun or extend those Windows claims.
- Windows system-player compatibility, NSIS installation/upgrades, user problem originals and real Dolby Vision footage were not verified. Synthetic HDR and analysis-pipeline tests are not algorithm-accuracy evaluations.
