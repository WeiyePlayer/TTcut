# TTcut v1.2.4

[简体中文](release-notes-v1.2.4.md) | **English**

`v1.2.4` is a stable maintenance release in the TTcut 1.2 line. It fixes long CPU-only exports that could fail at a fixed two-minute deadline during keyframe discovery.

## Long CPU-only exports

- The previous flow decoded and scanned the whole video for keyframes before segmented encoding and applied a fixed 120-second FFprobe deadline. Long videos could be terminated before any segment began encoding.
- Keyframe discovery now reads packet-level timestamps and keyframe flags from FFprobe instead of decoding every video frame.
- Export keyframe, audio-packet-boundary, and stream-signature probes no longer share a fixed 120-second deadline. Long tasks can run according to video duration and machine performance.

## Cancellation and component setup

- Export probes and output validation receive the task cancellation signal. Cancelling or exiting still terminates the active FFprobe/FFmpeg process tree and reports `EXPORT_CANCELLED`.
- Media-component extraction and analysis-runtime self-tests no longer depend on a fixed two-minute deadline. Cancelling component installation still aborts the corresponding subprocess.
- Removing the shared deadline does not remove cancellation or allow cancelled tasks to keep running in the background.

## Scope

- This release does not change analysis models, dynamic ROI, ball trajectories, bounce detection, rally recognition, bounce-count recognition, cut boundaries, or encoding-quality settings.
- The installer continues to use the pinned `CN=weiye` self-signed Authenticode certificate, RFC 3161 timestamping, and a signed update manifest. Windows systems that do not trust the certificate may still show Unknown Publisher or SmartScreen warnings.

## Verification

- PR #54 passed TypeScript type checking, Vitest (191 passing, 17 skipped), an H.264 B-frame packet/frame keyframe-equivalence integration test, runtime-script syntax checking, and a static scan for fixed 120-second configuration.
