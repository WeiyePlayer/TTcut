# TTcut v1.1.4

[简体中文](release-notes-v1.1.4.md) | **English**

`v1.1.4` is a stable patch in the TTcut 1.1 line that fixes expired download links for the video-processing components.

## Video-processing component download fix

- The standard FFmpeg download used by the Video processing component now points to a pinned Release in the TTcut runtime-asset repository.
- The optional x264 encoding component is redirected at the same time, so first-time installation and reinstallation no longer use the expired pinned upstream link.
- The replacement URLs provide the same verified archives. File names, sizes, SHA-256 digests, FFmpeg versions, archive roots, and installation paths remain unchanged.
- The replacement URLs support the HTTPS Range requests required by the component downloader for partial reads and resumable downloads.

## User impact

- Users who have not installed the Video processing component can retry component installation after updating to `v1.1.4`.
- Existing standard FFmpeg and optional x264 installations are not replaced and do not need to be downloaded again.
- This release does not change video analysis, rally detection, dynamic ROI, bounce-count calculation, or video-export logic.

## Upgrading from an older version

Users on `v1.1.2` and `v1.1.3` can update in the application. The updater verifies the signed update manifest, installer digest, pinned release certificate, and RFC 3161 timestamp.

The old updater in `v1.1.0` and `v1.1.1` still cannot accept the self-signed installer. Download and run `TTcut-1.1.4-x64-Setup.exe` manually from the official Release page. The existing Installation Root, Component Store, and user data remain in place.

## Release verification

- The server-side sizes and SHA-256 digests for both FFmpeg assets match the pinned component-catalog values.
- Every component URL passed HTTPS Range verification; both repaired URLs returned HTTP 206 with the correct total file size.
- The official Release includes Setup, its blockmap, `latest.yml`, `update-manifest.json`, `update-manifest.json.sig`, `SHA256SUMS.txt`, and the SBOM.
