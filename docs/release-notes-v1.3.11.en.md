# TTcut v1.3.11

[简体中文](https://github.com/WeiyePlayer/TTcut/blob/v1.3.11/docs/release-notes-v1.3.11.md) | **English**

For Windows x64 and macOS 15+ on Apple Silicon.

## Changes

- Single-source HDR10+ and Dolby Vision 8.1/8.4 with confirmed HDR10/HLG-compatible base layers export automatically as BT.709, 8-bit 4:2:0 H.264 SDR. Real tone mapping precedes scoreboard overlays and HDR metadata removal; this is not relabeling. Unknown or incompatible Dolby Vision fails explicitly. Existing SDR, HDR10/HLG preservation and multi-source batch rules remain unchanged.
- Recover dynamic HDR seeks that lack HEVC parameter sets.
- Premiere XML no longer depends on video encoding, CFR rebuilding or scoreboard preparation. If trustworthy CFR media is unavailable, reference the original. Video failures retain successful XML, with separate errors for requested artifacts only.
- Strengthen legacy original-source recovery, source-change detection and CFR video/audio integrity checks; reject damaged caches and improve cancellation/cleanup throughout probing, preparation, encoding and publication.
- Windows hybrid v4 custom drafts respect confirmed excluded intervals, including short clips. Insufficient space requires adjustment or deselection, while manual editing remains available. Legacy histories retain prior behavior.
- macOS retains native Core ML, source-time analysis, observed-pause exclusions and compatible previews without model or default recognition changes.

## Packages

- **Windows x64 v1.3.11**: `TTcut-1.3.11-x64-Setup.exe`, including models, runtime, native preview and video tools. Fixed self-signed `CN=weiye` Authenticode certificate and RFC 3161 timestamp; untrusted systems may show Unknown Publisher or SmartScreen.
- **macOS 15+ Apple Silicon v1.3.11**: `TTcut-1.3.11-arm64-Setup.dmg` (recommended) and `TTcut-1.3.11-arm64-Setup.zip`. Intel Macs are unsupported.
- macOS packages are ad-hoc signed, not notarized. If blocked on first launch, allow them in System Settings > Privacy & Security. In-app updates remain disabled; no `latest-mac.yml` is provided.

## Verification and limitations

- Windows preparation records type checking and 104 related tests passing. Broader real-media/UI evidence is in the [Windows validation record](https://github.com/WeiyePlayer/TTcut/blob/develop/docs/windows-hdr-export-xml-validation-2026-10-29.md). This macOS release does not rerun or extend Windows real-machine claims.
- Actual Premiere import, NSIS installation/upgrades and other Windows devices were not verified. Unknown Dolby Vision profiles, mixed-HDR multi-source conversion and cross-machine history import remain outside scope.
- Full cache decoding can add unquantified overhead. Source identity checks cannot rule out intentional content replacement preserving file size and modification time.
- Corresponding source and license material for the pinned Windows libmpv build and linked dependencies, pending in the Windows draft, have not been verified complete; installer and update-check files do not establish completion.

## macOS release verification

- Type checking and 195 related tests passed; 3 were skipped for their environment. Native tests initially passed 51 cases and skipped 3 real-media cases; all 3 subsequently passed with real HDR10+ and Dolby Vision 8.1/8.4 sources.
- All 21 packaged-app checks passed. Four additional Dolby Vision combined-video playback/rally/XML checks and two real-UI XML fault-isolation checks passed. Original hashes remained unchanged; this does not establish match-analysis accuracy or actual Premiere import compatibility.
- Real-media cache-integrity tests passed 40 cases and skipped 2. One simulated-Windows MP3 fixture failed because bundled macOS FFmpeg lacks the libmp3lame encoder; it is not counted as passing. An app run was interrupted by a screenshot timeout; the complete 21-check rerun passed.
- DMG mounting, 29 arm64 native binaries, signature integrity and archive SHA-256 checks passed. Ad-hoc signature integrity is not Apple notarization.
- macOS build source: `b1d2ab0e1b2d8e7bfd700bf6606ba7f4da712903`, with a clean worktree recorded in the build manifest. Windows draft source: `018bb5a84fbe60f8fa1a04f1dd566541d05f7686`. Windows checksums match GitHub digests and update metadata agrees on version, filename and size. Windows signing/installation were not rechecked on this Mac.
- macOS DMG SHA-256: `155451a0431ace0b388671ea8e12a11234f0c722be87ac73fbc91bb7fa48db98`.
- macOS ZIP SHA-256: `2f87dc68800f9556cc5ff83f36b1dc5471a1c96dd2059fcccec7b7338cdd43bb`.
