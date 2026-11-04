# TTcut v1.3.9

[简体中文](https://github.com/WeiyePlayer/TTcut/blob/macos/docs/release-notes-v1.3.9.md) | **English**

For Windows x64 and macOS 15+ on Apple Silicon: scoreboard styles, razor splitting, undo/redo and a custom editing guide.

## Changes on both platforms

- Choose and save Classic Blue, Orange, Green Bar or Red/Blue scoreboard styles with visual previews. Existing data defaults to Classic Blue. Preview, scoreboard images and exports share styles, with improved rotated-video sizing.
- Edit scores before, between and after rallies. Editing pauses playback; gaps cannot assign a winner. Timeline red dots indicate manual starting scores or winners only.
- Split clips with the razor tool and playhead snapping, retaining at least one frame on each side. Splits preserve source relationships and recalculate counts from bounce timestamps; legacy clips without timestamps display a dash. Splitting clears both resulting clips' manual starting scores and winners.
- Undo/redo up to 100 edits, including splitting, adding/deleting clips, boundaries, selection and scores. Windows uses Ctrl+Z, Ctrl+Y or Ctrl+Shift+Z; macOS uses Cmd+Z and Cmd+Shift+Z.
- Save and reopen split clips in drafts, export them independently and update the loop target according to the playhead.
- A bilingual guide opens on first entry and can be reopened from the toolbar. Opening pauses playback; closing leaves it paused.

## Platforms and packages

- **Windows x64 v1.3.9**: `TTcut-1.3.9-x64-Setup.exe`, including models, runtime, native preview and video tools. Signed with the fixed self-signed `CN=weiye` Authenticode certificate and an RFC 3161 timestamp; untrusted systems may still show Unknown Publisher or SmartScreen warnings.
- **macOS 15+ Apple Silicon v1.3.9**: `TTcut-1.3.9-arm64-Setup.dmg` (recommended) and `TTcut-1.3.9-arm64-Setup.zip`. Intel Macs are unsupported. Native Core ML analysis, compatible preview and Swift scoreboard export are retained.
- macOS packages are ad-hoc signed, not notarized. If blocked on first launch, allow them in System Settings > Privacy & Security. In-app updates remain disabled; no `latest-mac.yml` is supplied.

## Before public publication

- The Windows native-preview NOTICE requires corresponding source and notices for the pinned GPL libmpv build and its linked dependencies. Those materials are absent from the current draft; retain draft status until supplied and verified.

## macOS verification

- Type checking, 98 related regressions and 6 native scoreboard tests passed. Real Electron checks passed for the guide (7), playback (23) and razor/undo interactions (9).
- All 21 packaged-app checks passed, covering offline startup, Core ML, 120 fps, decoded-frame advancement, HDR/VFR, history and export. Validation passed for 29 arm64 native binaries, DMG mounting, signature integrity and archive SHA-256 values.
- macOS source commit: `584ed28ad10e64b8608e4dc318cde59ab45b19ad`, with a clean worktree at build time. Windows checksum entries match GitHub asset digests; update metadata agrees on version, filename and size. Windows installation and signature tests were not rerun in this session.
- Signature-integrity checks do not imply Apple notarization. No real-match algorithm-accuracy comparison was performed.
