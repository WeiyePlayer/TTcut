# TTcut macOS migration

Status: implementation in progress. Baseline: `b9e359b3b7ea113dd5b23f203b03e53fb7690d88` (1.2.10).

## Accepted scope

- macOS 15+, arm64 only; Xcode manages the native SwiftUI application. Preserve the existing desktop layout, with AppKit where needed for video and timeline interactions.
- Keep BlurBall and table calibration architecture and checkpoint weights. Both shipping models use Core ML; Python is development-only. No TrackNet or Python inference fallback in the app.
- Bundle one FFmpeg/ffprobe runtime with x264 and x265, including 10-bit, HDR10/HLG and 8K processing. Reject dynamic HDR rather than silently losing metadata. No component selection, downloading or importing in the product.
- Preserve all/highlight/custom workflows, batch calibration followed by serial processing, combined MP4, separate rally MP4 and FCP7 xmeml XML. Keep current fast-segmented default without a new settings control; retain compatible export as an internal tested strategy.
- Persist analyses, covers, source identity and processing-media provenance. Do not import Windows history or persist custom drafts across sessions. Removing history must not remove originals or exported deliverables.
- Remove batch shutdown. Preserve other settings and Chinese/English interface behavior.
- Implement updater and exercise it against a local test feed. Production feed configuration, Developer ID and notarization are deferred. Upload artifacts only to a GitHub draft, never publish automatically.
- Do not acquire or perform final acceptance against real match, 8K, HDR10 or HLG footage. Build checks, numeric/model comparisons, domain tests, synthetic media tests and local update tests remain in scope.

## Architecture

`TTcut` (SwiftUI/AppKit) coordinates typed services and one active task. `TTcutWorker` is a native subprocess with JSON requests/JSONL progress and exactly one terminal result. `TTcutCore` contains domain algorithms and versioned data. A C/C++ bridge provides FFmpeg frame decoding and OpenCV preprocessing. All runtime assets are app-relative and must work offline without Homebrew, Node or Python.

Model conversion starts in FP32. Preserve BGR BlurBall preprocessing, RGB table preprocessing, interpolation, ROI sampling, temporal windows, threshold defaults and two-stage semantics. Compare against identical tensors evaluated by the existing Python implementation. Diagnose numerical mismatches; never silently relax assertions or replace the model.

Media probing retains rational frame rates/time bases, bit depth, chroma, range, transfer, primaries, matrix, rotation, SAR and HDR metadata. HDR-to-SDR inference frames are separate from original/processing media. HDR10/HLG exports retain the corresponding HEVC/10-bit metadata. All output uses validated partial files and atomic commit; failures/cancellation clean only task-owned intermediates.

History lives in Application Support/TTcut, uses atomic versioned JSON, rebuildable indices, fingerprint validation and processing-media reference cleanup. Drafts remain session-only. UI lifetime cannot own running work.

## Milestones and gates

| Stage | Work | Gate |
|---|---|---|
| P0 | Freeze behavior, documents and asset manifests | Explicit source/test parity map |
| P1 | Verified checkpoints, Core ML conversion, native helper | Both models load and numeric/shape tests pass |
| P2 | Native domain and media services | Domain parity and synthetic export tests pass |
| P3 | All UI workflows/history/batch | Interactive/error-state and persistence checks pass |
| P4 | Updater, Xcode archive, standalone DMG | Local upgrade and dependency-isolation checks pass |
| P5 | Report, checksums and draft upload | Results and deferred validations clearly separated |

## Validation

- Model output target: `abs(error) <= 1e-4 + 1e-3 * abs(reference)`, with no nonfinite results. Use fixed test seeds and preserve conversion provenance.
- Domain fixtures compare Swift and existing implementations, including the strict five-second grouping boundary, one-second tail, overlap union, custom selection/manual clips, three-second bounce grouping and two-stage refinement.
- Synthetic media covers H264/HEVC, 8/10-bit, CFR/VFR, silent/stereo/multichannel, rotation/SAR, HDR10/HLG and short 8K files. Validate frame/PTS boundaries, expected duration, <=100ms audio/video skew, bit depth and metadata as well as decoding.
- Exercise cancellation, stale task events, corrupt history, missing/changed input, unwritable output, missing assets and subprocess failure.
- Verify app architectures, deployment targets, rpaths, bundle resources and offline launch. Current host: M5/16GB, macOS 26.6.2, Xcode 26.6. macOS 15 runtime validation is separately reported, not inferred from deployment target.
- Real footage quality/accuracy and real NLE XML import remain deferred and are never reported as passed.

## Deliverables

Xcode project, native app/helper, deterministic resource/conversion/build scripts, tests, verification report, local-signed app/DMG and SHA256 manifest. GitHub uploads target draft releases only. No production updater endpoint is activated in this work.
