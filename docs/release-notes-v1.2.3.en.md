# TTcut v1.2.3

[简体中文](release-notes-v1.2.3.md) | **English**

`v1.2.3` is a stable TTcut 1.2 feature release with a validated custom rally-clip editing workflow.

## Custom clip editing

- Custom mode opens a dedicated editing page. Rallies can be selected or cleared individually, and a clip or list row starts its preview.
- The timeline supports dragging clip start and end boundaries and the playhead. The mouse wheel pans; `Ctrl` + wheel zooms around the pointer.
- Space toggles playback. The video monitor uses contain-fit so the complete frame stays visible while editing.

## Export validation and state

- Custom export passes explicit final `segments`; Main revalidates rally IDs, finite values, source bounds, minimum frame duration, ordering, and overlap before FFmpeg starts.
- Invalid ranges return `INVALID_CUSTOM_SEGMENTS`. Exactly touching valid segments may be merged; other overlaps are rejected rather than silently rewritten.
- Cancelling an export preserves the current custom edits. Returning to the mode page resets them for the next export.
- `all` and `highlight` modes retain Main's existing boundary calculation.

## Scope

- This release does not change analysis models, dynamic ROI, ball trajectories, rally recognition, or bounce-count recognition.
- The installer continues to use the pinned `CN=weiye` self-signed Authenticode certificate, RFC 3161 timestamping, and a signed update manifest. Windows systems that do not trust the certificate may still show Unknown Publisher or SmartScreen warnings.

## Verification

- PR #51 passed TypeScript type checking, Vitest (188 passing, 16 skipped), and the real-video Electron flow, covering custom timeline interaction and export validation.
