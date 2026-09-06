# TTcut Windows v1.3.1

[简体中文](release-notes-v1.3.1.md) | **English**

`v1.3.1` is a stable TTcut update for Windows x64. It fixes an error that caused the export feature to behave incorrectly.

## Fixes

- Fixed an error that caused the export feature to behave incorrectly.
- Segmented exports and separate-rally exports now report progress from the actual cumulative duration of their clips, avoiding an early jump toward completion after the first clip.
- If fast stream copy fails and falls back to re-encoding, export progress continues within a reserved range. Progress reaches 100% only after output validation succeeds.
- The app now prevents suspension while long-running work such as analysis or export is active, then releases that state when the task finishes or is cancelled, reducing unexpected mid-task interruptions.

## Scope

- These notes cover the Windows x64 changes. macOS `v1.3.1` uses a separate release branch and runtime implementation.
- This update addresses the confirmed export-progress and long-task suspension paths. It does not establish that every export failure across all sources, codecs, and devices has been eliminated.

## Verification

- TypeScript type checking passed. Vitest passed 276 tests across 48 files, with 3 files and 17 tests conditionally skipped.
- The website production build and 2 rendered-page tests passed.
- A packaged Electron workflow passed real CUDA analysis, single-rally export, and final preview, while revalidating the bundled model assets.
