# TTcut v1.2.6

[简体中文](release-notes-v1.2.6.md) | **English**

`v1.2.6` is a stable TTcut 1.2 release focused on custom-cut segment exports and the Premiere Pro workflow while retaining the combined MP4 as the default behavior.

## Custom rally segment exports

- Custom mode can export each selected rally as an independent MP4, while still allowing the combined MP4 to be generated.
- Combined MP4, independent rally videos, and Premiere XML can be enabled independently or together; disabled artifacts do not trigger their corresponding encoding or file writes.
- Each export uses a dedicated collision-safe output directory, avoiding overwrites of the source video or existing results. Cancelling an export cleans up temporary artifacts from that run.
- If only some requested artifacts succeed, the UI preserves the completed results and reports a partial-success state so the output directory can be inspected.

## Premiere Pro XML and channel links

- Added Premiere Pro-importable FCP7 `xmeml` v4 XML. The XML references the original media and writes editable in/out points for every selected rally.
- XML uses a continuous video track and audio tracks matching the source channel count. Mono, stereo, and no-audio media receive the appropriate links; stereo sources correctly link A1/A2 audio tracks.
- This is not a native `.prproj`, AAF, or FCPXML project. If the source video moves, relink the media in Premiere.

## Timeline and branding

- Improved boundary dragging for short clips on the custom timeline while keeping independently usable edge hit areas for precise adjustments.
- Synchronized TTcut branding icon assets across the app, installer, and website.

## Scope

- This release primarily changes custom export, XML generation, timeline interaction, and branding assets. It does not change model weights, dynamic ROI, ball detection, rally recognition, or board-count recognition algorithms.
- v1.2.5’s bundled BlurBall default, selectable TrackNet model, and batch-task stability fixes remain included.
- The installer continues to use the pinned `CN=weiye` self-signed Authenticode certificate, RFC 3161 timestamping, and a signed update manifest. Windows systems that do not trust the certificate may still show Unknown Publisher or SmartScreen warnings.

## Verification

- `npm run typecheck` passed.
- Serial Vitest passed: 42 test files passed, with 207 tests passed and 17 skipped.
- Worker pytest passed: 64 tests passed.
- The website production build and rendered HTML tests passed: 2 tests passed.
- The official NSIS build passed; the installer, blockmap, `latest.yml`, signed update manifest, SBOM, and SHA-256 manifest were generated.
- Authenticode and update-manifest signatures match the pinned `CN=weiye` certificate thumbprint and include an RFC 3161 timestamp. The real-video Electron end-to-end workflow was not rerun before this release.
