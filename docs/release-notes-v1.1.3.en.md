# TTcut v1.1.3

[简体中文](release-notes-v1.1.3.md) | **English**

`v1.1.3` is a stable patch in the TTcut 1.1 line. It reduces inflated rally bounce counts caused by closely spaced duplicate candidates and improves compatibility with complex MP4 stream layouts.

## Rally and bounce-count recognition

- The default minimum bounce interval changes from 0.12 to 0.315 seconds, filtering closely spaced duplicate candidates such as those produced around net contacts.
- Debouncing always compares against the last retained bounce. Ignored candidates do not move the baseline, so a later genuine candidate remains eligible once it satisfies the interval.
- Candidates exactly 0.315 seconds apart are retained; only intervals strictly below the threshold are discarded. Boundary and non-transitive regression cases cover this behaviour.
- Saved analysis results are not migrated automatically. New analyses and explicit reanalysis use the new rule.

TTcut's displayed “bounce count” remains a proxy derived from ball-bounce events in the table region; it is not per-stroke paddle-hit recognition. This change addresses confirmed duplicate candidates and inflated counts rather than promising ground-truth stroke counts under every recording condition.

## Complex-video and runtime compatibility

- Analysis and automatic-calibration Workers force a larger OpenCV FFmpeg packet-read budget so auxiliary audio, timecode, telemetry, and descriptor streams in GoPro HEVC files do not exhaust the default budget prematurely.
- MP4 files with many auxiliary streams no longer stop after decoding only a small fraction of the video and then misleadingly report that no valid rallies were found.
- When the decoded frame count is materially below the metadata frame count, TTcut reports an explicit video-decoding error, separating media compatibility failures from videos that genuinely contain no valid rallies.
- This improves compatibility with complex video streams and Worker process environments; it does not expand the official platform target beyond Windows x64.

## Upgrading from an older version

Users on `v1.1.2` can update in the application. The updater verifies the signed update manifest, installer digest, pinned release certificate, and RFC 3161 timestamp.

The old updater in `v1.1.0` and `v1.1.1` still cannot accept the self-signed installer. Download and run `TTcut-1.1.3-x64-Setup.exe` manually from the official Release page. The existing Installation Root, Component Store, and user data remain in place.

## Release verification

- Full TypeScript, Vitest, and Worker regression suites cover the Worker environment, decode-completion guard, and 0.315-second debounce boundary.
- Real CUDA video analysis verifies complete decoding of a complex GoPro file and confirms that no retained bounce interval is below 0.315 seconds.
- The official Release includes Setup, its blockmap, `latest.yml`, `update-manifest.json`, `update-manifest.json.sig`, `SHA256SUMS.txt`, and the SBOM.
