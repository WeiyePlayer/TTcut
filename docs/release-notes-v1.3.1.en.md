# TTcut macOS v1.3.1

[简体中文](release-notes-v1.3.1.md) | **English**

`v1.3.1` is an update for macOS 15+ on Apple Silicon focused on export performance and known-issue fixes. The current stable Windows release remains `v1.3.0`.

## Export performance

- Segmented export seeks near each requested source range before decoding instead of repeatedly processing from the beginning of the video.
- The fixed two-thread limit has been removed, allowing FFmpeg, x264, and x265 to select encoder and filter threading for the host.
- In a same-video comparison using the same 14 merged segments and a 211.174-second target duration, export time fell from approximately 682.301 seconds to 145.636 seconds: about 4.68 times faster and a 78.66% wall-time reduction. The old timing is approximate because it was derived from a file timestamp with one-second precision; results vary with hardware, codecs, and source media.
- Decoded-video SSIM was `1.000000`; decoded-audio SHA-256 and video/audio frame counts also matched between the compared outputs.

## Fixes

- Fixed the macOS Continuous motion rally-recognition option not reaching native analysis. When selected, the native Worker now runs the Continuous motion algorithm and returns the corresponding rallies.
- Fixed known issues and removed the obsolete macOS UI implementation. The macOS product continues to use the Electron interface with native Core ML analysis and media services.

## Platform and packages

- **macOS 15+ · Apple Silicon · v1.3.1**: includes DMG (recommended) and ZIP packages with native Core ML analysis and media runtimes bundled. Intel Macs are not supported.
- `latest-mac.yml` release metadata is included; automatic updates remain disabled in the current macOS application.
- Packages are ad-hoc signed and not Apple-notarized. If macOS blocks first launch, allow TTcut in System Settings > Privacy & Security.
- The current stable Windows release remains `v1.3.0` and is not included among this macOS release's assets.

## Verification

Release verification results will be added after the final build completes.
