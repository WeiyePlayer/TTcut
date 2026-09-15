# TTcut Windows v1.3.5

[简体中文](https://github.com/WeiyePlayer/TTcut/blob/v1.3.5/docs/release-notes-v1.3.5.md) | **English**

`v1.3.5` is a stable update for Windows x64 focused on custom-cut playback, HEVC preview reliability, and installer compatibility.

## Custom-cut playback

- Space now consistently pauses or resumes playback. When focus remains on a rally row, checkbox, playback mode, or another button, Space no longer replays the rally, changes selection, or activates the focused control.
- Holding Space does not toggle repeatedly, composition input is left alone, and Enter keeps its existing rally and button activation behavior.

## Windows HEVC compatible preview

- HEVC videos on Windows now prepare a compatible preview directly instead of treating metadata or first-frame decoding as sufficient proof that later rally seeks will work.
- Switching to the compatible preview preserves playback position and intent, reducing black frames or stalled playback after seeking to a custom rally.

## Installer

- **Windows x64 · v1.3.5**: `TTcut-1.3.5-x64-Setup.exe`, a full installer containing the required runtime resources for a one-step setup.
- Installer registration is now written and immediately read back by native NSIS code without invoking PowerShell. Enterprise execution policies, language modes, PATH, or .NET state no longer gate registration; failures retain a diagnostic log outside the rollback directory.
- The installer uses the pinned `CN=weiye` self-signed Authenticode certificate, an RFC 3161 timestamp, and a signed update manifest. Windows may still show Unknown publisher or SmartScreen on systems that do not trust this certificate.
- This GitHub Release remains a draft and no `v1.3.5` tag is pushed.

## Verification

- TypeScript type checking passed. Vitest passed 423 tests across 62 files, with 25 tests across 6 files skipped by their existing conditions. All 222 Python regression tests passed.
- The production website build and both rendered-page tests passed.
- Eighteen Windows Electron checks passed with real media, covering Space control, seeking, continuous playback, temporary previews, and result playback.
- The full installer passed pinned-model, assisted-NSIS, installation-layout, and runtime-delivery checks. The application, uninstaller, and outer Setup carry the pinned certificate and RFC 3161 timestamps; the signed update manifest, SBOM, and SHA-256 checksums were generated.
