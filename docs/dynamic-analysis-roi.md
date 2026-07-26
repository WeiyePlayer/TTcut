# Dynamic Analysis ROI

TTcut derives a fixed per-video analysis rectangle from the existing manual or
automatic four-corner table calibration. The rectangle affects only the frames
fed to TrackNet; source media, trajectory coordinates, rally timestamps, and
final exports remain in the original video coordinate system.

## Geometry

- The current calibrated `274 cm x 152.5 cm` plane is expanded by `35 cm` and
  `25 cm` on each corresponding axis.
- The expanded quadrilateral is mapped to the source frame and wrapped in an
  outer bounding rectangle.
- The top boundary is extended upward by `0.5` times the longer of the two
  projected table-length edges.
- The result is clipped to the source-frame bounds. Empty or invalid geometry
  is `ANALYSIS_ROI_FAILED`.

## Model input

TrackNet keeps its sequence length, background mode, batch size, and checkpoint.
The ROI is resized with the same per-axis scale as the former full-frame
`512x288` input, rounded up to an 8-pixel-compatible tensor size. Heatmap points
are mapped through the ROI scale and origin before existing trajectory, bounce,
and rally processing. The comparison reports CUDA-synchronised model-forward
time separately from Predictor and post-load end-to-end wall time. Checkpoint
loading is measured once in `run_config.model_load_seconds` and excluded from
both variants because both runs share the same loaded checkpoint.

## Istanbul 2026 validation

The specified 1920x1080, 20,131-frame video was analysed twice on CUDA with the
same checkpoint and batch size.

| Measurement | Full frame | Requested 35/25 cm ROI | Conservative 75%/35% comparison* |
| --- | ---: | ---: | ---: |
| Tensor | 512x288 | 224x128 | 360x168 |
| Tensor pixel ratio | 100% | 19.44% | 41.02% |
| Pure model-forward time | 88.895 s | 19.756 s | — |
| Predictor wall time | 282.636 s | 108.710 s | 150.140 s |
| Post-load end-to-end wall time | 282.670 s | 108.736 s | — |
| Predictor average FPS | 71.23 | 185.18 | 134.08 |
| Visible frames | 5,383 | 4,824 | 5,219 |
| Bounce candidates | 151 | 161 | 150 |
| Rally groups | 38 | 38 | 38 |

For the requested ROI, jointly visible detections differed from the full-frame
baseline by a median of 1.41 source pixels and a 95th percentile of 3.61 pixels.
However, the requested ROI produced 559 fewer visible frames, 66 baseline-only
bounce frames, and 76 ROI-only bounce frames, so it is not evidence of accuracy
equivalence. Both runs produced 38 rally groups. The conservative comparison
produced 164 fewer visible frames while retaining a substantial speed improvement.

`*` The conservative run is a test-only margin override; its recorded wall time
predates the split timing fields, so it is intentionally not presented as a pure
model-forward or end-to-end measurement.

The source video's SHA-256 was
`9bf7676b1a3a400d3318f26393f263b73fe2c834692d35ac66f4fa33c42083ed`
before and after both analyses.

## Annotated videos

Both diagnostic videos use the original `1920x1080`, `60 FPS`, `20,131`-frame
source timeline and retain the source audio:

- `artifacts/dynamic-roi/full_frame_trajectory.mp4` — full-frame baseline ball
  points and continuous-only trajectory segments.
- `artifacts/dynamic-roi/dynamic_roi_trajectory.mp4` — dynamic ROI ball points,
  continuous-only trajectory segments, and the ROI outer bounding box.
