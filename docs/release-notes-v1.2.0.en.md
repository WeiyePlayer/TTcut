# TTcut v1.2.0

[简体中文](release-notes-v1.2.0.md) | **English**

`v1.2.0` is the first stable release in the TTcut 1.2 line. It includes the optional CUDA dual-model recognition profile, dynamic-ROI analysis, export recovery, and workflow improvements for single-video and batch tasks. TrackNet remains the default model.

## Optional dual-model recognition

- Settings provides a Default model and a CUDA-only New model. The new profile filters a SegFormer++ B2 main model through a WASB auxiliary model.
- Upgrading neither changes an existing model selection nor downloads the new models automatically. Their weights are installed only after the user selects the new profile.
- The profile requires the CUDA Analysis component. Missing or corrupt weights, or unavailable CUDA, block analysis with a repair path instead of silently falling back to TrackNet.
- Single-video analysis, batch tasks, and history retain the actual model profile, ROI, and main/auxiliary input dimensions.

## Dynamic ROI and analysis inputs

- Both profiles use the calibration-derived dynamic ROI. TrackNet retains its 1.25x sampling policy.
- The new profile derives inputs from the decoded video resolution and ROI dimensions: the main model uses one-half width and height aligned to 4 pixels, while the auxiliary model uses two-fifths aligned to 8 pixels.
- Main and auxiliary detections are mapped back to source-video coordinates and consensus-filtered before entering the existing trajectory, bounce-detection, rally-grouping, and `bounce_count` pipeline.
- The release includes fixes for colour preprocessing, heatmap subpixel localisation, short-gap trajectory recovery, and bounce-plateau disambiguation.

## Export reliability and recovery

- Export validation no longer relies on one fixed duration threshold. It derives a media-aware tolerance from video frame rate, audio boundaries, and the number of merged segments.
- Multi-segment VFR/AAC output is checked against both encoded-segment durations and the original selected ranges, reducing false failures caused by accumulated rounding.
- Structural checks for resolution, codecs, audio, A/V sync, timestamps, rotation, and metadata run first. If structurally valid output still exceeds the timing budget, TTcut retains it under a collision-safe filename and offers recovery actions in both single-video and batch workflows.
- This does not conceal genuinely corrupt output, missing streams, or unreadable files.

## Workflow improvements

- Active single-video and batch workflows stay mounted while navigating among Auto Cut, History, and Settings, so switching pages no longer loses the processing view.
- Conflicting component-setup and history actions are blocked while a task owns the workflow.
- Batch processing can optionally shut down Windows after every item completes successfully. Failed, cancelled, manually blocked, or still-running items prevent shutdown.
- Settings displays the high-accuracy dual-detection component's installation status and actual path.

## Model downloads

The dual-model weights are neither committed to Git nor bundled in the installer. TTcut downloads them on demand from the pinned [dual-ball-models-1.0.0 runtime-asset Release](https://github.com/WeiyePlayer/TTcut-runtime-assets/releases/tag/dual-ball-models-1.0.0):

- `ttcut-ball-main-segformerpp-b2-1.0.0.pt`: 99,091,962 bytes; SHA-256 `f2e8b1050866a8bba540f731b379ee510a792f1af91996cb3bbc9cc0953f096e`.
- `ttcut-ball-aux-wasb-1.0.0.pt`: 6,085,114 bytes; SHA-256 `73bfe091d22dcca40f2ab19671370bb0f4236b451041dcbe72e8feefdb8539a0`.

Downloads support retry, resumption, per-file hash verification, and atomic installation of the pair. The two original weights can also be imported manually from Settings.

## Updates and compatibility

- `v1.2.0` uses the stable `latest.yml` update channel. Both stable installations and `v1.2.0-beta.1` installations can upgrade to this release.
- The installer continues to use the pinned `CN=weiye` self-signed Authenticode certificate, an RFC 3161 timestamp, and signed update-manifest verification. Windows systems that do not trust this certificate may still show Unknown Publisher or SmartScreen warnings.
- Windows x64 remains the official target. TTcut does not block specific Windows build numbers; component and runtime self-checks determine practical compatibility.

## Verification boundary

- TypeScript checks passed; Vitest completed with 166 passing and 10 environment-gated skipped tests; all 65 Worker tests passed.
- The pinned dual-model weights passed size and SHA-256 verification. Strict real-CUDA loading produced main `[1, 1, 135, 240]` and auxiliary `[1, 1, 432, 768]` output shapes.
- Seven real multi-segment OpenH264/x264 export integration tests passed. A real Electron workflow completed CUDA analysis, single-rally export, and final preview.
- The official NSIS build passed bundled-model, component-catalog, installation-layout, Fuse, Authenticode, RFC 3161 timestamp, and signed-update-manifest verification.
- Real-weight verification has no human-labelled ground truth. It confirms model loading, workflow execution, and objective output only, not a comparative accuracy ranking. Release verification did not trigger an actual Windows shutdown; automated tests cover the shutdown safeguards.
