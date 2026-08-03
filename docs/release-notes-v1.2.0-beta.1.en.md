# TTcut v1.2.0-beta.1

[简体中文](release-notes-v1.2.0-beta.1.md) | **English**

`v1.2.0-beta.1` is the first prerelease in the TTcut 1.2 line. It adds an optional Uplifting dual ball-recognition profile while retaining the default TrackNet profile and its existing behaviour.

## New ball-recognition profile

- Settings now offers two global profiles: Default model continues to use TrackNet, while New model filters a SegFormer++ B2 main model through a WASB auxiliary model.
- TrackNet remains the default. Upgrading neither changes an existing setting nor downloads the new models automatically.
- The new profile can be selected only when a CUDA Analysis component is available. CPU users can see the option and its explanation but cannot start its download or analysis.
- First selection downloads two pinned weights totalling 105,177,076 bytes. The application checks each file's size and SHA-256 and persists the selection only after both files are installed atomically.
- Missing or corrupt weights, or an unavailable CUDA runtime, block analysis and direct the user to repair the component. TTcut never silently falls back to TrackNet.

## Dynamic ROI and analysis output

- Both profiles share the existing calibration-derived dynamic ROI. TrackNet retains its 1.25× sampling policy; the new profile does not apply that oversampling.
- The new profile derives inputs from the decoded resolution and ROI dimensions: the main model uses one-half width and height aligned to 4 pixels; the auxiliary model uses two-fifths aligned to 8 pixels.
- Main and auxiliary coordinates are mapped back to the source frame and filtered at a 20-pixel distance normalised to 1920×1080. Accepted detections use the main-model coordinate.
- Removed an extra BGR-to-RGB conversion after ROI cropping so preprocessing matches the original Uplifting colour conditions. Heatmap subpixel localisation, short-gap trajectory recovery, and bounce-plateau disambiguation are also included.
- The profile feeds the existing bounce detector, three-second rally grouping, and `bounce_count`. The displayed count remains the number of table bounces, not racket contacts.
- Single-video analysis, batch analysis, and history retain the actual profile, ROI, and main/auxiliary input sizes.

## Model downloads

The weights are not committed to the Git repository or bundled in the installer. TTcut downloads them on demand from the pinned [dual-ball-models-1.0.0 runtime-asset Release](https://github.com/WeiyePlayer/TTcut-runtime-assets/releases/tag/dual-ball-models-1.0.0):

- `ttcut-ball-main-segformerpp-b2-1.0.0.pt`: 99,091,962 bytes; SHA-256 `f2e8b1050866a8bba540f731b379ee510a792f1af91996cb3bbc9cc0953f096e`.
- `ttcut-ball-aux-wasb-1.0.0.pt`: 6,085,114 bytes; SHA-256 `73bfe091d22dcca40f2ab19671370bb0f4236b451041dcbe72e8feefdb8539a0`.

Downloads support retries, resumption, per-file hash verification, and atomic installation of the pair. The two original weights can also be imported manually from Settings.

## Beta update channel

- This Release is a GitHub Pre-release and publishes only `beta.yml`. Existing stable installations such as `v1.1.4` do not receive it automatically.
- Once this Beta is installed, the updater remains eligible for later Beta releases and falls back to a newer stable release's `latest.yml` when that stable release is published.
- The installer continues to use the pinned `CN=weiye` Authenticode certificate, an RFC 3161 timestamp, and signed update-manifest verification.

## Verification

- Deterministic Worker integration tests cover profile routing, dynamic ROI, main/auxiliary input sizes, consensus filtering, source-coordinate mapping, bounce detection, and rally output.
- A real-weight CUDA smoke test covers strict checkpoint loading and 960×540 main plus 768×432 auxiliary inputs.
- The final new-profile run on the Istanbul test video processed 20,131 frames and reported six bounces in the third rally. The source video's size and SHA-256 were unchanged.
- The video has no human labels. The A/B report records objective differences only and does not claim an accuracy ranking.

See the [Istanbul ball-model A/B report](benchmarks/uplifting-dual-v1-istanbul-ab.md) for the complete conditions and results.
