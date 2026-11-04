# TTcut v1.3.8

[简体中文](https://github.com/WeiyePlayer/TTcut/blob/v1.3.8/docs/release-notes-v1.3.8.md) | **English**

For Windows x64 and macOS 15+ on Apple Silicon, adding persistent editing drafts, per-rally scoreboards, and loop playback.

## Editing on both platforms

- History saves clip selection, edited boundaries, playback mode, scoreboard settings, and export options.
- Scoreboards support Chinese and English player names, game and point scores, positioning, scaling, and overlays in combined or separate exports. Choosing a rally winner advances to the next rally.
- Loop the current rally's edited range with persistent target highlighting. Clicking another rally changes the target independently of export selection.
- History writes are serialized; unfinished tasks do not overwrite the last successful result.

## Windows

- Native original-media previews improve seeking, pausing, scrubbing, input handling, and reopening the editor.
- Validated DirectML sessions are reused; acceleration failures retry smaller batches and fall back to CPU when needed. Completion waits for task cleanup.
- `TTcut-1.3.8-x64-Setup.exe` includes models, runtimes, native preview, and video tools. It uses the pinned self-signed `CN=weiye` certificate and RFC 3161 timestamps. Untrusted systems may show Unknown publisher or SmartScreen.

## macOS

- Retains native Core ML analysis, source-time exclusions, and compatible previews. Native Swift scoreboard exports support rotated video, HDR10, and HLG.
- Fixes score editing at the beginning, in gaps, and after rallies. Display and saving use a defined selected rally. Double-clicking a field pauses playback to preserve editing focus.
- `TTcut-1.3.8-arm64-Setup.dmg` (recommended) and `TTcut-1.3.8-arm64-Setup.zip` require macOS 15+ and Apple Silicon. Intel Macs are unsupported.
- Packages are ad-hoc signed and not notarized. If blocked on first launch, allow the app in System Settings > Privacy & Security. In-app updates remain disabled; no `latest-mac.yml` is provided.

## Verification scope

- Windows preparation records report successful type checking, 510 project tests with 25 skipped, and 259 Python tests with three skipped; five original-preview and eight scoreboard checks passed, along with automated package-signature and update-manifest verification.
- macOS release checks passed type checking and 85 relevant regression tests, plus 11 packaged editing/export checks covering score input, decoded loop playback, draft restoration after restart, and actual scoreboard output. DMG mounting, dependencies for 29 arm64 native files, signature integrity, and archive SHA-256 verification passed.
- No manual Windows installer run or real-match analysis-accuracy comparison was performed. Signature-integrity checks are not Apple notarization.
