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
outer bounding rectangle. Resize that ROI to a stride-8 dynamic TrackNet tensor,
using a default `1.25x` multiplier over the former full-frame per-axis scale,
then map every detection back into Source-frame Trajectory coordinates. Invalid
ROI geometry is a hard `ANALYSIS_ROI_FAILED` result.

## Consequences

The source video and export path remain unchanged, and the model processes fewer
input pixels. The geometry is an intentional table-relative heuristic rather
than physical 3D reconstruction. The adopted `1.25x` production default
(`280x160` for the Istanbul ROI) reduced tensor pixels to `30.38%` and
Predictor wall time from `259.460 s` to `125.343 s` versus the full-frame
baseline, while detecting 248 fewer visible frames and producing 165 bounce
candidates and 41 rally groups. This is not evidence of accuracy equivalence;
the larger tensor recovered 311 visible frames relative to the prior `224x128`
experiment but also changed the rally count. The default is therefore a
confirmed speed/coverage trade-off, not an accuracy guarantee.
