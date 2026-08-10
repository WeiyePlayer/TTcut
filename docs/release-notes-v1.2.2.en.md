# TTcut v1.2.2

[简体中文](release-notes-v1.2.2.md) | **English**

`v1.2.2` is a stable maintenance release in the TTcut 1.2 line. It improves A/V synchronization, concat timestamps, and playable-output recovery for segmented exports.

## Segmented concat and A/V synchronization

- Independently encoded AAC segments can introduce small packet-duration rounding differences that accumulate into a visible A/V duration delta after concatenation. Concat manifests now use each encoded segment's measured duration plus a small guard derived from the video time base.
- Audio-bearing concat output safely pads audio to the video endpoint after asynchronous resampling and ends at the shortest stream, preventing audio from ending early or extending indefinitely.
- Independently encoded x264 segments disable B-frames to avoid equal or regressing decode timestamps at concat boundaries. Verification covers both the default OpenH264 path and the optional x264 path.
- This fix targets accumulated AAC rounding and x264 concat timestamps. It does not imply that every `EXPORT_CONCAT_FAILED` has the same cause.

## Playable-output recovery

- If FFmpeg has already produced a playable video but a later validation, rename, or history step fails, TTcut probes the file and retains it at the normal output path or under a collision-safe `_with_warning` name.
- The single-video workflow shows the normal export preview with an added warning panel, error code, localized explanation, technical details, and a logs-folder action.
- The batch workflow marks the item complete with a warning, preserves preview and file actions, and continues processing remaining items.
- Unreadable output is not retained as a successful result. Explicit user cancellation remains a cancellation state.

## Scope

- The release does not change selected intervals, output resolution, encoding quality, or normal output naming.
- It does not relax A/V synchronization, timestamp, codec, resolution, or media-readability validation. A warning explicitly means that later processing reported an error, not that the file passed every validation step.
- It does not change the ball-recognition models of that release, dynamic ROI, ball trajectories, bounce detection, rally grouping, or `bounce_count`.

## Updates and signing

- `v1.2.1` installations can upgrade through the in-app updater.
- The installer continues to use the pinned `CN=weiye` self-signed Authenticode certificate, an RFC 3161 timestamp, and signed update-manifest verification. Windows systems that do not trust this certificate may still show Unknown Publisher or SmartScreen warnings.

## Verification boundary

- Automated coverage includes encoded-segment concat durations, AAC endpoint padding, x264 decode timestamps, playable and unreadable output recovery, and single-video and batch warning UI.
- This release passes TypeScript type checking, `172` Vitest tests, and `65` Python worker tests; another `16` tests are skipped because they do not apply to the current environment. The production website build and `2` rendered-HTML assertions also pass.
- Dual-encoder media integration reports `12` passing cases and `1` encoder-conditional skip, covering multi-segment AAC synchronization, x264 concat boundaries, VFR, abnormal frame durations, decoding, and timestamp monotonicity.
- A real nine-group export reports A/V duration deltas of about `12.9 ms` with OpenH264 and `19.2 ms` with x264. Audio and video PTS/DTS remain monotonic, with no Non-monotonic DTS warning.
