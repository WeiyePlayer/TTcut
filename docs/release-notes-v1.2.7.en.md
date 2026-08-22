# TTcut v1.2.7

[简体中文](release-notes-v1.2.7.md) | **English**

`v1.2.7` is a stable TTcut 1.2 release focused on refining the custom-cut page and fixing interaction and validation issues in the custom export flow.

## Custom-cut page

- Reorganized the custom-cut workspace, video monitor, rally list, and compact navigation so reviewing, selecting, and editing rallies is more focused.
- Added rally scrolling for short-clip editing and long rally-list browsing.
- The custom timeline can now create a manual rally clip. A new clip starts as one second at the chosen position, is re-sorted by time, and updates its displayed count from bounce events inside its range.
- Manual rally clips can be deleted while detected rallies remain editable and selectable.

## Export safety and interaction fixes

- The export-options panel now stays open while the pointer moves from its trigger into the panel, fixing accidental closure that prevented selecting an output method.
- Before processing begins, export independently validates the source, identifier, range, order, and overlap of manual and detected rallies; invalid selections are rejected early.
- Combined video, per-rally video, and Premiere XML continue to consume the same validated clip sequence. Valid touching clips remain mergeable under the existing rules.
- Fixed legacy-install migration backup verification and rollback on compatible PowerShell environments that do not provide the system hash command.

## Scope

- This release primarily improves the custom page, manual rally editing, and export-boundary validation. It does not change model weights, ball detection, rally recognition, board-count recognition, or dynamic ROI algorithms.
- Existing combined MP4, per-rally MP4, and Premiere-importable XML export options remain available.
- The installer continues to use the pinned `CN=weiye` self-signed Authenticode certificate, RFC 3161 timestamping, and a signed update manifest. Windows systems that do not trust the certificate may still show Unknown Publisher or SmartScreen warnings.

## Verification

- `npm run typecheck` passed; serial Vitest: 44 files passed, 218 tests passed, and 17 skipped.
- Worker tests: 64 passed; website build and rendered-HTML tests passed.
- The real-video end-to-end flow passed: analysis, timeline zooming and scrolling, manually adding/removing rallies, clip adjustment, export, and preview were verified.
- Installer signing, update-manifest signing, and release-asset verification were completed before publication.
