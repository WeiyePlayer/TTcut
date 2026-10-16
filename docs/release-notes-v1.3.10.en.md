# TTcut Windows v1.3.10

[简体中文](https://github.com/WeiyePlayer/TTcut/blob/develop/docs/release-notes-v1.3.10.md) | **English**

`v1.3.10` is a stable Windows x64 update focused on runtime isolation, export fidelity, and legacy-history recovery.

## Analysis runtime

- Isolate bundled Python module paths from system `PYTHONHOME`, `PYTHONPATH`, user packages, and conflicting external modules during component checks, automatic calibration, and analysis.
- Retain the existing BlurBall model, `hybrid_motion_bounce` rally recognition, real-model DirectML validation, and CPU fallback. Default analysis sampling is unchanged.

## Video exports and previews

- Bundled video tools now support x265. HDR10/HLG and HEVC inputs export as HEVC/hvc1; other SDR inputs use H.264. Supported 8/10-bit depth, chroma, color information, and static HDR metadata are retained.
- Improve VFR timestamps, frame durations, and final-frame handling. Merged highlights retain their existing common dimensions, frame rate, and audio rules; incompatible color/depth/HDR profiles are rejected rather than silently converted to SDR.
- Faithful Dolby Vision/HDR10+ re-encoding remains unsupported. Export rejects these inputs before dynamic metadata can be lost; unsupported bit depths also produce an explicit error.
- HDR/HEVC exports can use compatible preview copies for playback and seeking. Preview copies never replace original or exported media.

## History and batch exports

- Reprobe original media before exporting old Windows histories instead of relying on legacy CFR caches that may have lost HDR information.
- Recover opening and exporting when a legacy CFR cache is missing but the original path and fingerprint still match, without rewriting original analysis metadata. Missing or modified originals remain protected by validation.
- Batch exports check only participating sources. Unselected or empty sources no longer block exports or determine the output profile.

## Release files and limitations

- **Windows x64 full installer**: `TTcut-1.3.10-x64-Setup.exe`, including models, analysis runtime, native preview, and video tools.
- Uses the pinned `CN=weiye` self-signed Authenticode certificate and an RFC 3161 timestamp. Systems that do not trust this certificate may still show Unknown publisher or SmartScreen.
- The GitHub Release is prepared as an unpublished draft only. No new macOS installer is included.
- Real Dolby Vision originals, specific user-reported videos, Windows system-player behavior, and interactive NSIS installation/upgrades were not tested in this round. HDR fixtures are synthetic; real-match analysis validates the pipeline, not new algorithm accuracy.

## Verification

- Type checking passed in this round, along with all 103 targeted regressions for isolation, fidelity policy, history recovery, exports, and UI workflows. Website build and both rendering checks passed.
- Official build, package contents, pinned certificate/timestamps, and detached update-manifest signature checks passed, including models, DirectML/CPU runtime, native preview, and x264/x265 contracts.
- The signed 1.3.10 application passed seven isolated-profile checks: components, automatic calibration, and BlurBall analysis under external Python pollution; HLG/HDR10+ detection; dynamic-HDR export rejection; missing legacy CFR recovery; and actual HLG export, full decoding, compatible-preview playback/seeking. Original/export hashes remained unchanged and the application exited normally.
- Broader implementation acceptance is documented in the [Windows runtime and export validation](https://github.com/WeiyePlayer/TTcut/blob/develop/docs/windows-runtime-fidelity-validation-2026-10-16.md). Its full suite was not repeated for this release preparation.

## Before public publication

- Check and complete corresponding source and license distribution materials for the pinned native-preview/libmpv build and linked dependencies. This draft includes only the installer and update verification files.
