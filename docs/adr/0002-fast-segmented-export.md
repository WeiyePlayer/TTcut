# ADR 0002: Fast segmented export alongside Compatible Export

## Status

Accepted

## Context

The previous multi-segment export used one `filter_complex` graph. FFmpeg
therefore decoded the input from the beginning for selections whose segments
were far apart. The application supports both `libopenh264` and `libx264`, and
must preserve the existing validated output path while offering a faster
alternative.

## Decision

TTcut has two explicit export strategies:

1. Compatible Export remains the default and keeps stream-copy priority for a
   single packet-aligned segment, followed by the existing filter graph.
2. Fast Segmented Export seeks to the previous keyframe, serially encodes each
   segment with precise relative trims, validates segment stream signatures,
   and concatenates with the FFmpeg concat demuxer.

A task snapshots its strategy and encoder at start. All temporary segments in a
task use the same video/audio parameters; mixing encoders is forbidden.
Temporary files use controlled ASCII names in a task-specific hidden directory.
Fast-mode errors do not silently fall back to Compatible Export.

Task cancellation is tracked by a persistent controller across the gaps between
segment processes. User cancellation is `EXPORT_CANCELLED`; application exit
records `app-exit`; an unrequested signal or null exit is
`EXPORT_TERMINATED`.

## Consequences

Fast segmented export avoids decoding long unused intervals, at the cost of
serial segment encodes and a strict concat compatibility check. The final
output still passes the existing ffprobe validation and is atomically renamed.
No progress UI or hardware encoder is added.
