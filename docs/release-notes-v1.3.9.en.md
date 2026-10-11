# TTcut Windows v1.3.9

[简体中文](https://github.com/WeiyePlayer/TTcut/blob/develop/docs/release-notes-v1.3.9.md) | **English**

`v1.3.9` is a stable update for Windows x64 with scoreboard styles, razor splitting, undo/redo, and a custom-editing guide.

## Scoreboards

- Four styles are available: classic blue, orange, green, and red-blue dual panels. Settings preview and save the choice; existing data retains the classic blue style.
- Native video preview, scoreboard images, and exported videos use matching styles and dimensions, with improved sizing for rotated videos.
- Scores can be edited before, between, and after rallies. Editing pauses playback, and rally winners cannot be assigned in gaps.
- Red dots on timeline clips identify manual starting scores or rally winners. Automatically inherited scores do not create markers.

## Editing and guidance

- The razor tool splits a clip into adjacent parts, snaps to the playhead, and requires at least one frame on either side.
- Splits preserve video ranges and source associations. Bounce counts are recalculated within each part; older records without bounce timestamps show “—”. Splitting clears manual starting scores and winner annotations on both parts.
- Up to 100 undo/redo steps cover splitting, adding/removing clips, boundaries, selection, scores, and winners. Windows supports Ctrl+Z, Ctrl+Y, and Ctrl+Shift+Z, including when native preview has focus.
- Split clips can be saved in drafts, reopened, and exported separately. Splitting a loop target follows the part containing the playhead.
- A bilingual custom-editing guide opens on first use and can be revisited from the toolbar. Opening it pauses playback and hides the native video window behind the guide; closing leaves playback paused.

## Release files

- **Windows x64 full installer**: `TTcut-1.3.9-x64-Setup.exe`, including analysis models, runtimes, native preview, and video tools.
- The installer uses the pinned `CN=weiye` self-signed Authenticode certificate and an RFC 3161 timestamp. Windows may still show Unknown publisher or SmartScreen when the certificate is not trusted.
- The GitHub Release remains a draft and is not publicly published. No new macOS installer is included.

## Before public publication

- The bundled native-preview NOTICE requires corresponding source and license materials for the pinned build and its linked dependencies. Check and complete those materials before publishing; this draft includes the installer and update verification files only.
