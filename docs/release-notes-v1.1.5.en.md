# TTcut v1.1.5

[简体中文](release-notes-v1.1.5.md) | **English**

`v1.1.5` is a stable hotfix in the TTcut 1.1 line. It fixes valid exports being reported as failures because duration validation was too strict.

## Export-duration false-failure fix

- Post-export production validation uses the existing two-second domain tolerance again instead of the stricter maximum of `0.1 seconds or two frames`.
- An output whose duration differs from the target by no more than two seconds is accepted; larger mismatches still return `EXPORT_DURATION_MISMATCH`.
- This primarily covers ordinary small duration drift introduced by FFmpeg segmented cutting, time-base handling, or container muxing.
- Other checks for readability, minimum file size, resolution, codecs, audio, A/V synchronization, start timestamps, rotation, and metadata remain unchanged.

## User impact

- Users who previously received an export-duration mismatch or export-failed message after cutting completed can retry after updating to `v1.1.5`.
- This release fixes the `EXPORT_DURATION_MISMATCH` false rejection only. It does not change failures caused by missing components, insufficient disk space, encoder errors, or damaged source media.
- This release does not include the dual-model feature from `v1.2.0-beta.1`, and it does not change video analysis, dynamic ROI, rally detection, or bounce-count logic.

## Upgrading from an older version

Users on `v1.1.2`, `v1.1.3`, or `v1.1.4` can update in the application. The updater verifies the signed update manifest, installer digest, pinned release certificate, and RFC 3161 timestamp.

The old updater in `v1.1.0` and `v1.1.1` still cannot accept the self-signed installer. Download and run `TTcut-1.1.5-x64-Setup.exe` manually from the official Release page. The existing Installation Root, Component Store, and user data remain in place.

## Release verification

- Export-validation regression tests cover acceptance within the two-second tolerance and rejection beyond it.
- Real OpenH264 and x264 segmented-export integration tests cover video, audio, timestamps, and final output validation.
- The official Release includes Setup, its blockmap, `latest.yml`, `update-manifest.json`, `update-manifest.json.sig`, `SHA256SUMS.txt`, and the SBOM.
