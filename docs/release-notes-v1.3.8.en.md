# TTcut Windows v1.3.8

[简体中文](https://github.com/WeiyePlayer/TTcut/blob/develop/docs/release-notes-v1.3.8.md) | **English**

`v1.3.8` is a stable update for Windows x64 focused on custom editing, scoreboard exports, original-media previews, and analysis reliability.

## Custom editing and scoreboards

- Editing drafts are saved with history records. Reopening restores clip selection, edited boundaries, playback mode, scoreboard settings, and export options.
- Per-rally scoreboards support player names, editable scores, positioning and scaling, and overlays in exported videos. Choosing the rally winner advances to the next rally.
- A new loop mode repeats the current rally's edited range. The rally list highlights the loop target, and clicking another rally changes it without changing export selection.

## Preview and analysis reliability

- Native Windows preview in custom cutting plays the original video directly, improving seeking, pausing, and timeline scrubbing.
- Fixed input handling in native previews, reopening the editor, and playhead positioning after scrubbing.
- Validated DirectML sessions are reused to reduce repeated initialization. Acceleration failures during analysis trigger smaller-batch retries, with CPU fallback when necessary.
- Analysis completion is reported after task cleanup to reduce incorrect busy errors on subsequent tasks. History writes are serialized, and unfinished runs do not overwrite the last successful result.

## Release files

- **Windows x64 full installer**: `TTcut-1.3.8-x64-Setup.exe`, including analysis models, runtimes, native preview, and video tools.
- The installer uses the pinned `CN=weiye` self-signed Authenticode certificate and an RFC 3161 timestamp. Windows may still show Unknown publisher or SmartScreen when the certificate is not trusted.
- The GitHub Release remains a draft and is not publicly published. No new macOS installer is included in this release preparation.

## Before public publication

- The bundled native-preview NOTICE requires corresponding source and license materials for the pinned build and its linked dependencies. The current draft assets do not include the complete corresponding-source package; add it before publishing.

## Verification

- TypeScript type checks passed. Project tests: 510 passed, 25 skipped, including a scoreboard export integration test using actual video encoding. Python Worker tests: 259 passed, 3 skipped.
- This packaged Windows build passed 5 original-media preview checks and 8 scoreboard editing checks, covering playback, pause, reopening, timeline scrubbing, Chinese names, score input, and wheel adjustments.
- The official installer build passed automated model/runtime integrity checks, native-preview file hash verification, Authenticode verification, and signed-update manifest verification.
- No manual installer run or real-video analysis-quality comparison was performed. The macOS build was not verified.
