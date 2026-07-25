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

## Batch Task

A serial queue of independent video analyses. A failure for one item does not
prevent later items from running.

## History Record

A persisted local analysis outcome, including zero-rally outcomes, associated
with an immutable source-video fingerprint.
