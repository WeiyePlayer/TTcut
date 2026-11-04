# TTcut Windows v1.3.12

[简体中文](https://github.com/WeiyePlayer/TTcut/blob/develop/docs/release-notes-v1.3.12.md) | **English**

## Changes

- Port calibration-frame fallback commit `396d830` to Windows develop. When browser video decoding is unavailable, FFmpeg extracts the selected frame so table calibration can continue.
- Extracted frames respect display rotation, tone-map HDR for preview and use bounded dimensions. Original media is never replaced.
- Rapid seeking prioritizes the latest frame request and ignores stale results. Calibration requires an available frame; extraction failures are reported explicitly.
- Add restricted frame-extraction IPC and an image media channel with source access control and shutdown cleanup. Retain Windows native preview interfaces and compatible-preview disabling behavior.
- BlurBall models, default sampling, rally recognition and export policies are unchanged.

## Delivery and limitations

- Windows x64 full installer: `TTcut-1.3.12-x64-Setup.exe`, including models, runtimes, native preview and video tools. Uses the pinned `CN=weiye` self-signed certificate and timestamps; SmartScreen/Unknown publisher warnings remain possible.
- As requested, this round does not run unit tests, type checking, real-media/UI acceptance or additional verification. Checks built into the official packaging workflow remain enabled. No functional acceptance is claimed.
- Release draft only; not publicly published. No new macOS installer is included.
- Before public publication, check and complete corresponding source/license materials for the pinned native-preview/libmpv build and linked dependencies.
