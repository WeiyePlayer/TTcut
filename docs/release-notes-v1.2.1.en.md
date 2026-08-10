# TTcut v1.2.1

[简体中文](release-notes-v1.2.1.md) | **English**

`v1.2.1` is a stable maintenance release in the TTcut 1.2 line. It fixes A/V duration drift caused by abnormal source-frame durations during segmented export.

## A/V synchronization fix

- Some source videos contain unusually large or irregular per-frame durations. Newer FFmpeg `setpts` behaviour can retain related frame-rate metadata, causing trimmed video duration to diverge from audio and eventually trigger `EXPORT_AV_SYNC_MISMATCH`.
- Single-segment and multi-segment trim paths for both OpenH264 and x264 now use `setpts=PTS-STARTPTS:strip_fps=1`, removing inherited frame-rate metadata while regenerating timestamps.
- Export continues to use `-fps_mode vfr` to preserve variable frame rate. It does not add a fixed `-r` value or force the source to constant frame rate.
- Concat manifests for silent videos now include the explicit duration of every selected segment so abnormal frame durations do not propagate into the final output.

## Validation and diagnostics

- Output must still pass readability, resolution, H.264, AAC, timestamp, rotation, metadata, total-duration, and A/V synchronization checks.
- The allowed A/V duration delta remains 0.1 seconds and has not been relaxed.
- A validation failure now records video duration, audio duration, actual delta, and allowed tolerance, distinguishing genuine A/V drift from other export failures.
- Recovery of structurally valid output that exceeds the media-aware total-duration budget is unchanged.

## Scope

- The fix covers both the default OpenH264 component and the optional x264 component.
- It does not change selected intervals, output resolution, encoding quality, or output naming.
- It does not change the ball-recognition models of that release, dynamic ROI, ball trajectories, bounce detection, rally grouping, or `bounce_count`.

## Updates and signing

- `v1.2.0` installations can upgrade through the in-app updater.
- The installer continues to use the pinned `CN=weiye` self-signed Authenticode certificate, an RFC 3161 timestamp, and signed update-manifest verification. Windows systems that do not trust this certificate may still show Unknown Publisher or SmartScreen warnings.

## Verification boundary

- Automated coverage includes abnormal frame-duration cleanup, VFR preservation, silent-segment durations, A/V diagnostic details, and segmented-concat timestamps.
- This release passes TypeScript type checking, `168` Vitest tests, and `65` Python worker tests; another `12` tests are skipped because they do not apply to the current environment.
- Real OpenH264/x264 segmented-export integration adds `9` passing cases covering decoding, monotonic DTS, VFR, multi-segment output duration, and A/V duration delta.
