# TrackNet CUDA pipeline performance report — 2026-07-27

## Result

The final Predictor completed in **78.931 s**, versus **125.922 s** for the
untouched baseline: **46.992 s shorter (37.32%)**. This exceeds the 10%
acceptance threshold.

The Pinned Buffer / asynchronous transfer step alone measured 1.43% slower
than the synchronous bounded pipeline. Because the plan treats changes below
5% as measurement uncertainty, that step has **no demonstrated performance
benefit** in this single-run experiment.

## Fixed inputs

- Baseline Git branch / HEAD: `fix/cudatest` /
  `46f14ff1085603f2367af0d61824bd754362d2a8`
- Video: Istanbul 2026 final, 101,153,938 bytes
- Video SHA-256:
  `9bf7676b1a3a400d3318f26393f263b73fe2c834692d35ac66f4fa33c42083ed`
- Calibration SHA-256:
  `8068c2542b23fd4c3b9bae839fd63bc8424ab131f0fb68edf24023a17dd1379f`
- Model SHA-256:
  `ffb5469161c4bd39a5a7e745c3d13f076b2c5e575f33279ea62f1e5803245a52`
- Device / Batch / sequence / background: CUDA / 4 / 8 / `concat`
- Analysis ROI: `(487, 238)–(1307, 707)`, source size `1920x1080`
- Model input: `280x160`, FP32

The source-video hash was identical before and after every formal run.

## Environment

- Windows 11 build 26100, x64
- NVIDIA GeForce RTX 4060 Laptop GPU, 8,188 MiB
- NVIDIA driver 566.36
- Python 3.12.13
- PyTorch 2.12.1+cu126 / CUDA runtime 12.6
- OpenCV 4.13.0 / NumPy 2.5.1

## Formal single-run checkpoints

| Checkpoint | Predictor | Forward | FPS | vs previous | vs baseline |
|---|---:|---:|---:|---:|---:|
| Untouched baseline | 125.922 s | 30.830 s | 159.87 | — | — |
| Preallocated assembly | 96.949 s | 22.347 s | 207.65 | 28.974 s / 23.01% faster | 23.01% faster |
| Bounded pipeline | 77.820 s | 25.584 s | 258.69 | 19.129 s / 19.73% faster | 38.20% faster |
| Pinned + async + Events | 78.931 s | 25.267 s | 255.05 | 1.111 s / 1.43% slower | 37.32% faster |

The changed forward timings are not attributed to input allocation: model
math did not change, and GPU warm-up and system state were not independently
controlled. `predictor_seconds` is the acceptance metric.

## Output equivalence

A separate end-to-end equivalence run loaded the untouched Predictor directly
from baseline Git HEAD and compared it with the final implementation:

- Frames: 20,131 in both runs
- Visible frames: 5,135 in both runs
- Normalized full trajectory SHA-256, including
  `frame/time/visibility/x/y/source/confidence/time_source`:
  `2e70199cd0e8128f466f327f566a28d8a01ebd900a8490a854da4e65502edf59`
- Maximum absolute confidence difference: `0`
- Bounce frames: identical, 165
- Rally summaries: identical, 41
- Source video hash before/after: identical

Raw checkpoint and equivalence JSON files remain in the ignored local
`.baseline/analysis-pipeline/20260727-cuda-pipeline/` directory.

## Interpretation and limits

Each formal checkpoint is one complete run on one laptop, so the measurements
do not provide confidence intervals. Differences below 5% are deliberately
reported as uncertain. The final 37.32% cumulative reduction is well above the
10% threshold, but repeated runs would be required to estimate a stable mean.

The implementation changes allocation and scheduling only. It does not change
the model, checkpoint, ROI, thresholds, Batch size, bounce/rally rules, Worker
protocol, Electron IPC, or UI.

Windows 11 has live execution evidence in this run. Windows 10 22H2 x64 receives
only static compatibility evidence: no new Windows API or build gate, no new
DLL/runtime dependency, no `multiprocessing` or shared memory, and unchanged
Python/PyTorch/OpenCV packaging. This report does not claim Windows 10 hardware
validation.

## Final validation

- Worker Python: 44 passed.
- TypeScript typecheck: passed.
- Vitest: 25 files / 78 tests passed; 3 files / 8 tests retained their existing
  conditional skips.
- CPU smoke: existing `2.12.1+cpu` managed runtime, 301-frame Istanbul clip,
  `280x160`, batch 4, serial Predictor; 9.047 s and 33.27 FPS.
- Model asset validation and local Windows x64 Electron Forge package: passed.
- Source, staged, and packaged Predictor SHA-256:
  `5f711f4a936839cf71b4e4545d29a307b00ef2ee81e14029c2dd780beff0b21f`.
- Real Electron CUDA E2E with explicit `1-193.mp4`, CUDA runtime, model, and
  FFmpeg: passed in 52.5 s. It completed analysis, persisted History, played
  the third-rally preview, exported one rally, and loaded the final video.
- The E2E's former fixed expectation of 47 rallies was checked against the
  untouched `46f14ff` Predictor and found stale: the baseline produces 41
  rallies with the same Calibration, including rally 3 at 32.032–38.204 s.
  Only the test expectation was updated.
- Windows diagnostic: Windows 11 24H2 build 26100, Client, x64, 100% DPI,
  compatibility status `supported`. No installer or signing smoke was run.
