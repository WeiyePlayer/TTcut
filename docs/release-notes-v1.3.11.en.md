# TTcut Windows v1.3.11

[简体中文](https://github.com/WeiyePlayer/TTcut/blob/develop/docs/release-notes-v1.3.11.md) | **English**

## Changes

- Single-source HDR10+ and Dolby Vision 8.1/8.4 with compatible HDR10/HLG base layers automatically export as BT.709, 8-bit 4:2:0 H.264 SDR. Real tone mapping precedes scoreboard overlays and removes HDR metadata; this is not relabeling. Unknown/incompatible Dolby Vision remains an explicit error. Existing SDR, HDR10/HLG preservation and multi-source batch rules remain unchanged.
- Recover dynamic-HDR seeks with missing HEVC parameter sets.
- Premiere XML no longer depends on video encoding, CFR rebuilding or scoreboard preparation. It references originals when trustworthy CFR media is unavailable. Video failures do not discard successful XML, and errors are reported per requested artifact.
- Strengthen original-source recovery, source-change validation and CFR video/audio integrity checks. Improve cancellation and cleanup throughout probing, preparation, encoding and publication.
- Initial hybrid v4 custom drafts respect confirmed excluded ranges, including short clips. Insufficient safe space produces actionable validation instead of silently crossing boundaries; manual editing remains available. Legacy histories retain their existing behavior.

## Installer and verification

- Windows x64 full installer: `TTcut-1.3.11-x64-Setup.exe`, including models, runtimes, native preview and video tools. Uses the pinned `CN=weiye` self-signed Authenticode certificate and RFC 3161 timestamps. SmartScreen warnings remain possible when the certificate is not trusted.
- Existing full-suite, real-media and UI evidence is documented in the [Windows acceptance record](https://github.com/WeiyePlayer/TTcut/blob/develop/docs/windows-hdr-export-xml-validation-2026-10-29.md). Full acceptance is not repeated in this round; release-build results are checked separately.
- This GitHub Release remains an unpublished draft. No new macOS installer is included.
- Type checking and all 104 targeted regressions passed in this round, covering export color policy, recovery, history, XML, custom clips and UI workflows.

## Limitations and publication checklist

- Interactive NSIS installation/upgrades, actual Premiere imports, other Windows devices and native macOS acceptance are not performed in this round. Unknown Dolby Vision profiles and mixed-HDR multi-source conversion remain outside automatic conversion support; cross-machine history import is not included.
- Before public publication, check and complete corresponding source/license materials for the pinned native-preview/libmpv build and linked dependencies. This draft includes only installer and update-verification assets.
