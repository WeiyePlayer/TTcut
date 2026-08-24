# TTcut v1.2.9

[简体中文](release-notes-v1.2.9.md) | **English**

`v1.2.9` is a stable TTcut 1.2 release that adds optional high-precision analysis and preferential constant-frame-rate processing for variable-frame-rate video.

## Analysis precision and rally recognition

- Settings now provides Analysis precision. Default keeps the established whole-video analysis; High precision first finds candidate rallies, then performs a finer second analysis over expanded candidate intervals.
- Final rallies and counts in High precision come only from the second analysis, rather than directly reusing first-stage candidates. This provides finer review around candidates at the cost of additional processing time.
- The analysis configuration is frozen when a batch begins, so one batch cannot mix precision settings.
- Candidate-interval preparation, progress stages, and settings defaults were improved. Existing saved settings are preserved.

## Variable-frame-rate video processing

- Calibration always uses the original video. When variable frame rate is detected, TTcut preferentially creates constant-frame-rate processing media at an exact target frame rate.
- Analysis, post-analysis preview, cutting, and newly created Premiere XML use the processing media. The original video remains the source for history identity, calibration, thumbnails, and default output naming.
- Processing media is cached by source fingerprint and target frame rate, then cleaned up on failure, cancellation, or when no history record still references it.
- If space is insufficient, transcoding fails, or output validation fails, TTcut reports the reason and continues analysis with the original VFR video. Cancellation and exit do not silently fall back.

## Scope

- This release does not claim a single quantified accuracy percentage. Results still depend on video quality, calibration, selected analysis precision, and the local machine.
- The installer continues to use the pinned `CN=weiye` self-signed Authenticode certificate, RFC 3161 timestamping, and a signed update manifest. Windows systems that do not trust the certificate may still show Unknown Publisher or SmartScreen warnings.

## Verification

- `npm run typecheck` passed; serial Vitest: 46 files passed, 235 tests passed, and 17 were skipped.
- Worker tests: 45 passed; website build and rendered-HTML tests passed.
- Electron end-to-end tests: 9 passed and 1 was skipped by its environment condition, covering real component import, 125%/150%/200% DPI, real-video High precision analysis and export, automatic/manual batch recovery, and first-run component setup.
- Installer signing, update-manifest signing, release-asset digest verification, and re-downloaded-asset verification are completed before publication.
