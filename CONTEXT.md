# TTcut Context

## Analysis Model

An immutable checkpoint bundled with the application and verified by filename,
size, and SHA-256 before packaging.

## Analysis Runtime

The managed Python and PyTorch environment installed separately from the
application package to execute local analysis.

## Calibration

The four table-corner coordinates used for a video analysis. Calibration can
be provided manually or produced automatically from five sampled video frames.

## Analysis ROI

A conservative source-frame rectangle derived from Calibration and used only
to prepare ball-detection inputs. It never replaces or modifies source media.
_Avoid_: 3D column, crop video

## Source-frame Trajectory

Ball positions expressed in the original video's pixel coordinate system,
regardless of the Analysis ROI or model tensor size used for detection.
_Avoid_: Crop-relative trajectory

## Batch Task

A serial queue of independent video analyses. A failure for one item does not
prevent later items from running.

## History Record

A persisted local analysis outcome, including zero-rally outcomes, associated
with an immutable source-video fingerprint.

## Compatible Export

The default export strategy. It preserves the existing stream-copy priority
and the single `filter_complex` re-encode path for multi-segment selections.

## Fast Segmented Export

An opt-in export strategy that seeks to the previous keyframe, precisely trims
each segment, validates a stream signature, and joins the resulting segments
with the FFmpeg concat demuxer. A task chooses one encoder for all segments.

## Export Cancellation

Cancellation requested by the user is a terminal `EXPORT_CANCELLED` outcome.
Application shutdown records `app-exit` and cleans up without showing an error
page. An unrequested signal or null process exit is `EXPORT_TERMINATED`.
