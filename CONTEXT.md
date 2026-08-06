# TTcut Context

## Analysis Model

An immutable checkpoint bundled with the application and verified by filename,
size, and SHA-256 before packaging.

## Ball Model Profile

The global ball-recognition route recorded on every new analysis. `tracknet_v1`
is the default legacy route; `uplifting_dual_v1` is the optional CUDA-only
SegFormer++ B2 and WASB consensus route. A profile is never changed silently.
_Avoid_: automatic fallback, accuracy mode

## Dual Ball Model Component

The optional, versioned pair of Uplifting ball-model checkpoints installed on
first selection after both files pass their pinned size and SHA-256 checks.
The pair is committed atomically and is not bundled in the application.

## Model Input Size

The actual tensor width and height derived from the decoded source dimensions
and Analysis ROI. TrackNet keeps its 1.25× ROI sampling policy. Uplifting uses
one-half for the main input and two-fifths for the auxiliary input, without
the 1.25× multiplier.

## Board Count

The displayed `bounce_count`: the number of detected table bounces in a rally.
It is not a count of racket contacts.
_Avoid_: stroke count, paddle-hit count

## Rally

A detected interval in an `AnalysisResultV1`, identified by a stable rally ID
and bounded by its analyzed start and end times. Rally boundaries describe the
detected exchange; they are not necessarily final export boundaries.

## Custom Rally Clip

The editable export interval associated with exactly one Rally in the
single-video custom workflow. Its default start includes Before-rally time; its
default end includes the Rally end, one fixed closing second, and After-rally
time. Selected Custom Rally Clips never overlap on the single track.
_Avoid_: Rally, CutGroup

## Custom Cut Draft

The Renderer-owned, non-persisted set of Custom Rally Clips and selection
states for the current video. It survives cancellation of its own export but is
discarded when returning to mode selection, changing video, or restarting.
_Avoid_: History Record, project file

## Analysis Runtime

The managed Python and PyTorch environment installed separately from the
application package to execute local analysis.

## Installation Root

The stable user-selected folder that owns one TTcut installation and its managed
component data. Changing drives requires uninstalling before reinstalling.

## Program Area

The `app` area inside the Installation Root that contains replaceable TTcut
application files.
_Avoid_: Installation Root

## Component Store

The `data/components` area inside the Installation Root that contains managed
runtimes, media tools, downloads, staging, and rollback backups.
_Avoid_: AppData, Program Area

## Legacy Installation

A previous per-user Squirrel installation under LocalAppData that can be
replaced only after its Component Store has been copied and verified.
_Avoid_: Current installation

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

A serial queue that calibrates each video first and only then processes ready
items. Automatic calibration runs in list order before analysis or export;
an item that needs manual calibration remains a recoverable queue entry and
does not block ready items from running.

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

## Draft Release

A private, mutable GitHub Release used to upload and verify the complete
artifact set before publication.
_Avoid_: Public Stable Release

## Public Stable Release

A published, non-prerelease GitHub Release whose tag and artifacts are frozen.
Substantive corrections are delivered as a new patch version.
_Avoid_: Draft Release

## Signed Update Manifest

The exact `update-manifest.json` bytes and detached RSA-SHA256 signature shipped
with a Public Stable Release. The manifest binds one version, channel, installer
filename, size, SHA-512 digest, and Authenticode signer.
_Avoid_: latest.yml, SHA256SUMS

## Pinned Update Signer

An Authenticode certificate whose public certificate is compiled into the Main
Process. It verifies the Signed Update Manifest without adding the self-signed
certificate to a Windows trust store.
_Avoid_: Windows trusted root, publisher name alone

## Bootstrap Update

The one-time manual installation needed to move a version that only has the
default Windows trust verifier onto a version that understands Signed Update
Manifests. Subsequent updates can return to the automatic NSIS flow.
