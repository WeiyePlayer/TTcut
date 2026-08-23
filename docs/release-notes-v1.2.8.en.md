# TTcut v1.2.8

[简体中文](release-notes-v1.2.8.md) | **English**

`v1.2.8` is a stable TTcut 1.2 release that continues to refine the custom-cut page and desktop UI while fixing a set of workflow and interaction issues.

## Custom cutting and interface

- Further refined the custom-cut timeline, rally actions, and visual feedback so creating, deleting, previewing, and resizing clips is clearer and more reliable.
- Improved desktop layout, control states, upload guidance, and typography for small windows and high-DPI displays.
- Timeline scrolling is now clamped to real content bounds, preventing empty regions and positioning mismatches after scrolling.

## Local analysis and workflow fixes

- New videos now use the current built-in local analysis flow; retired options are no longer shown in Settings.
- Startup automatically removes retired settings left by older versions while preserving language, calibration, and clip-duration preferences.
- Removed retired bundled resources and maintenance scripts to reduce the local installer size.
- Fixed batch-task behavior, settings migration, and several UI interactions.

## Scope

- This release makes no accuracy or dynamic-ROI effectiveness claim based on a newly labelled data set. Results still depend on video quality, calibration, and the local machine.
- Combined MP4, per-rally MP4, and Premiere-importable XML output remain available.
- The installer continues to use the pinned `CN=weiye` self-signed Authenticode certificate, RFC 3161 timestamping, and a signed update manifest. Windows systems that do not trust the certificate may still show Unknown Publisher or SmartScreen warnings.

## Verification

- `npm run typecheck` passed; serial Vitest: 44 files passed, 218 tests passed, and 17 skipped.
- Worker tests: 35 passed; website build and rendered-HTML tests passed.
- Electron end-to-end tests: 9 passed and 1 was skipped by its environment condition, covering real component import, 125%/150%/200% DPI, real-video analysis and export, automatic/manual batch recovery, and first-run component setup.
- Installer signing, update-manifest signing, and release-asset verification were completed before publication.
