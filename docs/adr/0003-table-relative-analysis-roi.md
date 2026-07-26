# ADR 0003: Table-relative dynamic analysis ROI

## Status

Accepted

## Context

TrackNet previously resized every decoded frame to `512x288`, so cropping the
source view without reducing the actual tensor dimensions could not establish a
meaningful inference-speed gain. TTcut has four table-corner calibration in
both manual and automatic modes, but it does not have reliable camera
intrinsics for a strict 3D column projection.

## Decision

Derive a two-dimensional Analysis ROI from the existing calibrated table plane.
Expand each current calibration axis by the internal `35 cm` and `25 cm`
margins, project the expanded quadrilateral back into the source frame, extend
its top by half the longer projected table-length edge, and use the clipped
outer bounding rectangle. Resize that ROI to a stride-8 dynamic TrackNet tensor
while preserving the existing full-frame scale as closely as possible, then map
every detection back into Source-frame Trajectory coordinates. Invalid ROI
geometry is a hard `ANALYSIS_ROI_FAILED` result.

## Consequences

The source video and export path remain unchanged, and the model processes fewer
input pixels. The geometry is an intentional table-relative heuristic rather
than physical 3D reconstruction. Real-video validation found that the requested
`35/25 cm` default is fast but tight: it reduced tensor pixels to `19.44%`,
pure model-forward time from `88.895 s` to `19.756 s`, and Predictor wall time
from `282.636 s` to `108.710 s`, while detecting 559 fewer visible frames than
the full-frame baseline. This is not evidence of accuracy equivalence. A
`75%/35%` comparison retained more detections while still reducing Predictor
wall time, so future tuning should prefer larger margins when recognition
coverage matters more than maximum speed.
