# ADR 0008: Main validates Renderer-defined custom export ranges

## Status

Accepted

## Context

The original export boundary accepted only a mode, a threshold or rally IDs,
and enumerated global roll values. Main could therefore recompute every export
range from persisted analysis. The custom timeline must let a user edit each
rally's start and end independently, including trimming outside the detected
rally itself. Rally IDs and global roll values cannot represent that result.

Renderer state is not a trusted process boundary. Accepting its times without
independent checks could pass invalid, overlapping, or out-of-source ranges to
FFmpeg and undermine output-duration and resource preconditions.

## Decision

- Only the single-video `custom` selection accepts explicit segments. `all`
  and `highlight` retain Main-computed boundaries and enumerated roll values.
- Every custom segment carries one rally ID and final start/end seconds. It
  does not carry global roll values.
- Main opens the persisted analysis before interpreting custom segments. It
  rejects an empty list, unknown or duplicate rally IDs, non-finite values,
  source-range violations, durations shorter than one analyzed video frame,
  unsorted input, and overlap.
- Main may merge exactly touching validated segments into one `CutGroup`; it
  does not otherwise rewrite Renderer-submitted custom boundaries.
- Contract parsing failures for custom requests and semantic validation
  failures both surface as `INVALID_CUSTOM_SEGMENTS`.

## Consequences

The custom timeline can express independent clip edits while Main remains the
authority that decides whether FFmpeg may start. Renderer and Main share pure
validation helpers for consistent arithmetic, but Main always reruns them
against its own persisted `AnalysisResultV1`. Future custom features that add
movement, snapping, or persistence must preserve this validation boundary.
