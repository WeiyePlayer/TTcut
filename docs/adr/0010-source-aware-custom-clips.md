# ADR 0010: Main validates source-aware custom clips independently

## Status

Accepted

## Context

Custom Cut can now create a one-second Manual Rally Clip where there is no
detected Rally. A source Rally ID is consequently not available for every
editable interval, but Renderer state remains untrusted at the Main-process
boundary.

## Decision

- A custom export segment carries a stable `clip_id`, source (`detected` or
  `manual`), current display index, and final source-video start/end seconds.
  Detected segments additionally carry their source `rally_id`.
- Main opens the persisted analysis and independently validates IDs, source
  type, detected Rally membership, increasing positive display indices, finite
  in-video frame-sized ranges, sort order, and non-overlap before FFmpeg work
  begins.
- A manual segment is valid without a Rally ID. A detected segment is valid
  only when its Rally ID is present in the persisted analysis. Legacy segments
  with `{ rally_id, start_time_seconds, end_time_seconds }` remain accepted as
  detected segments.
- This ADR replaces the "every custom segment carries one rally ID" restriction
  in ADR 0008. All other Main-process trust-boundary decisions from ADR 0008
  remain in force.

## Consequences

Renderer can offer manual timeline edits without becoming an authority for
export safety. Combined video, per-clip video, and Premiere XML all consume
the same validated source-aware segment sequence.
