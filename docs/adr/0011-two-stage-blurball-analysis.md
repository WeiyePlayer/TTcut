# ADR 0011: Optional two-stage BlurBall refinement

- Status: accepted
- Date: 2026-08-24

## Context

TTcut's existing BlurBall route analyzes the whole source video with
non-overlapping three-frame windows. A second, optional route is needed to
revisit the time around candidate rallies with a stride-one sliding window.
The two routes must remain selectable from Settings, and older analysis
requests and history records must remain readable.

## Decision

Keep the existing whole-video route as `full` and the default. Add `two_stage`:

1. Run the existing full-video pass with its own confidence threshold.
2. Group its bounce events into Candidate Rallies, expand each by 0.75 seconds,
   clamp to the video, and merge overlapping or touching intervals.
3. Decode the video sequentially again. Use three-frame windows with stride one
   and retain only the center frame when its timestamp is inside a refinement
   interval. One adjacent frame outside an interval may be used as context;
   its prediction is discarded. Reset the online tracker between disjoint
   intervals.
4. Detect bounces and globally regroup rallies from the refinement trajectory.
   Stage-one candidates never enter the returned result. No candidate interval
   means an empty final result and no fallback pass.

The request protocol has a v2 discriminated analysis configuration. Workers
continue to accept v1 requests by interpreting them as `full`. Result
provenance records the selected mode and each stage's threshold and window
policy while preserving v1 history parsing.

## Consequences

- The default route retains its existing behavior and output contract.
- The two-stage route performs an additional sequential decode and can do more
  model work; it is not presented as a proven speed or accuracy improvement.
- Final Rally and Board Count values can differ from stage-one candidates because
  they are recomputed exclusively from stage-two results.
- Settings persist only the selected mode. All three thresholds are temporary
  session values and reset to their defaults after restart.
