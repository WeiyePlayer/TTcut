# ADR 0007: Optional Uplifting dual ball-model profile

## Status

Accepted

## Context

TTcut historically routes every analysis through TrackNet. A second route is
needed for a SegFormer++ B2 main detector and a WASB auxiliary detector without
changing existing users' results or increasing the base application download.
Both checkpoints require CUDA for the supported production path.

The persisted rally field named `bounce_count` counts table bounces. It does
not contain enough evidence to represent racket contacts.

## Decision

- `tracknet_v1` remains the default and retains the existing dynamic ROI and
  1.25× input scaling.
- `uplifting_dual_v1` is opt-in and CUDA-only. It uses the same source-frame
  dynamic ROI, but main and auxiliary inputs are respectively one-half and
  two-fifths of the ROI dimensions, with no 1.25× multiplier.
- The two checkpoints form versioned component `1.0.0`. Selection is persisted
  only after both files are downloaded, individually verified, and atomically
  installed. A missing, corrupt, or unusable selected component blocks analysis;
  the application never falls back silently.
- The worker accepts schema-v1 requests as `tracknet_v1` and writes schema-v2
  requests for new analyses. Result provenance is optional so old history stays
  readable.
- The two detectors consume the same decoded three-frame window and source ROI.
  Preprocessing preserves the original Uplifting checkpoint contract: decoded
  OpenCV frames remain in BGR channel order through resize and normalization.
  Predictions are mapped to source pixels. A point is accepted only when their
  Euclidean separation, normalized to 1920×1080, is at most 20 pixels; the main
  detector coordinate is retained. Both heatmaps use bounded quadratic peak
  refinement around the winning cell before source-coordinate mapping so the
  main detector is not restricted to its roughly eight-source-pixel grid.
- `bounce_count` remains the table-bounce count and continues through the
  three-second rally grouping. Before bounce detection, only dual-model
  trajectories bridge at most five consecutive missing frames spanning no more
  than 0.1 seconds. Flat vertical maxima are accepted as bounce candidates and
  use the earliest sample inside the permitted table region. TrackNet input and
  bounce behavior remain unchanged.

## Consequences

Existing installations do not download new assets or change behavior. CUDA
users can explicitly install and select the new route. CPU-only systems can see
the option but cannot select it. Release preparation must publish the exact two
assets named in `resources/components.json` before this branch is releasable.
