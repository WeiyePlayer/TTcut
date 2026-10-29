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
