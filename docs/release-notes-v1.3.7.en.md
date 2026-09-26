# TTcut Windows v1.3.7

[简体中文](https://github.com/WeiyePlayer/TTcut/blob/develop/docs/release-notes-v1.3.7.md) | **English**

`v1.3.7` is a stable update for Windows x64 focused on DirectML recovery, custom-cut previews, hybrid rally time boundaries, and bundled runtime files.

## Analysis reliability

- Ball detection retries DirectML with smaller batches when GPU memory or batch limits interrupt inference. If acceleration still fails, incomplete output is discarded and analysis restarts on CPU. Progress and results report the runtime actually used.
- Hybrid motion-and-bounce rally decisions use timestamps from the source video for rallies and excluded intervals. Frame numbers from a converted video are no longer treated as source-video time.
- Runtime checks identify missing or damaged files more clearly before analysis starts.

## Preview and installation

- Compatible previews in custom cutting better preserve playback position and pause state when seeking or switching media, particularly when a converted preview is needed.
- The Windows full installer now includes the Visual C++ runtime files required by the analysis runtime, with no separate installation step.
- Independent Beta builds use their own app identity and data directory. This stable build uses the stable-channel configuration.

## Release files

- **Windows x64 full installer**: `TTcut-1.3.7-x64-Setup.exe`, containing the analysis models, DirectML/CPU runtime, and video tools.
- The installer uses the pinned `CN=weiye` self-signed Authenticode certificate and an RFC 3161 timestamp. Windows may still show Unknown publisher or SmartScreen when the certificate is not trusted.
- The GitHub Release remains a draft and is not publicly published yet.

## Verification

- TypeScript type checks, project tests (460 passed, 25 skipped), Python Worker tests (236 passed), and website build/render tests passed.
- The official installer build passed automated model and runtime integrity checks, update-manifest signature verification, and installer Authenticode verification.
- No real-video quality comparison or manual installer run was performed for this release preparation.
