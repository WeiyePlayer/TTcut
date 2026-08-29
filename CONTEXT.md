# TTcut Context

## Analysis Model

An immutable checkpoint bundled with the application and verified by filename,
size, and SHA-256 before packaging.

## BlurBall Analysis Mode

The selected execution route for a new BlurBall analysis. `full` (shown as
“默认”) runs the existing whole-video pass. `two_stage` (shown as “高精”)
runs a full-video candidate pass followed by a center-frame refinement pass.
The label is a product name, not an accuracy guarantee.

## Candidate Rally

A Rally produced by the stage-one pass of a two-stage analysis. It is used only
to construct refinement intervals and is never returned as final analysis data.

## Refinement Interval

The closed time interval produced by expanding a Candidate Rally by 0.75 seconds
on both sides, clamping it to the source duration, and taking the union of
overlapping or touching intervals. Stage-two results are retained only when the
center-frame timestamp belongs to one of these intervals.

## Final Analysis Result

The Bounce Event Times, Rally records, and Board Counts returned to the UI. In
two-stage mode all three are computed only from the stage-two trajectory; if
stage one produces no Candidate Rally, the final result is empty.

## Ball Model Profile

The global ball-recognition route recorded on every new analysis. Bundled
`blurball_v1` is the default and supports the same managed CPU and CUDA runtimes
as the bundled `tracknet_v1` compatibility route. A profile is never changed
silently.
_Avoid_: automatic fallback, accuracy mode

## Model Input Size

The actual tensor width and height derived from the decoded source dimensions
and Analysis ROI. TrackNet and BlurBall keep the 1.25× ROI sampling policy.

## Board Count

For a detected Rally, the displayed `bounce_count`: the number of detected
table bounces in that Rally at analysis time. For a Manual Rally Clip, it is
the number of Bounce Event Times inside its current `[start, end)` interval;
it is unavailable for legacy analyses that did not retain those times. It is
not a count of racket contacts.
_Avoid_: stroke count, paddle-hit count

## Rally

A detected interval in an `AnalysisResultV1`, identified by a stable rally ID
and bounded by its analyzed start and end times. Rally boundaries describe the
detected exchange; they are not necessarily final export boundaries.

## Custom Rally Clip

The editable export interval in the single-video custom workflow. A detected
Custom Rally Clip retains one source Rally; a Manual Rally Clip has no source
Rally and begins as a user-created one-second interval. A detected clip's
default start includes Before-rally time; its default end includes the Rally
end, one fixed closing second, and After-rally time. Selected Custom Rally
Clips never overlap on the single track.
_Avoid_: Rally, CutGroup

## Playback Target Clip

The selected Custom Rally Clip whose half-open time interval contains the
current playback time. At most one Playback Target Clip exists at a time; a
gap or an unselected clip has no target.
_Avoid_: current selection, active Rally

## Rally Location Cue

A transient list-row indicator that connects playback or an explicit jump to
its Playback Target Clip. It does not change clip selection, focus, or the
Custom Rally Clip itself.
_Avoid_: persistent active row, selected Rally

## Manual Rally Clip

A Custom Rally Clip created directly on the timeline rather than from a
detected Rally. It has a stable manual clip ID, no Rally ID, and a Board Count
derived from retained Bounce Event Times when those are available.
_Avoid_: manually created Rally, detected Rally

## Bounce Event Time

The finite source-video timestamp for one valid detected table-bounce event.
`AnalysisResultV1.bounce_times_seconds` stores these times sorted and deduped,
including events that do not become a formal Rally.
_Avoid_: racket contact time, Rally boundary

## Custom Cut Draft

The Renderer-owned, non-persisted set of Custom Rally Clips and selection
states for the current video. It survives cancellation of its own export but is
discarded when returning to mode selection, changing video, or restarting.
_Avoid_: History Record, project file

## Rally Segment Video

One independently exported MP4 for one selected Custom Rally Clip. It is a
user-visible deliverable, not a temporary Fast Segmented Export file.
_Avoid_: Fast Segmented Export, CutGroup

## Custom Artifact Export

A custom-cut export that produces Rally Segment Videos and/or Premiere XML
instead of a combined video.
_Avoid_: Compatible Export, Fast Segmented Export

## Premiere XML

A Final Cut Pro 7 XML v4 interchange file that references the source video and
describes the selected Custom Rally Clips as a continuous editable timeline.
_Avoid_: PR project file, `.prproj`, FCPXML

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

## 原始媒体（Source Media）

用户选中的媒体文件及其路径、大小、修改时间和原始元数据。文件身份、历史指纹、封面、显示名称和默认输出名称始终绑定原始媒体。标定也读取原始媒体。

## 处理媒体（Processing Media）

球路分析、分析后预览和剪辑实际读取的媒体。源本来就是固定帧率时处理媒体就是原始媒体；可变帧率源仅在设置中启用“重编码为固定帧率”后使用 CFR 派生媒体，默认直接使用原始媒体。

## CFR 派生媒体（CFR Derived Media）

由 FFmpeg 从原始 VFR 媒体生成的 H.264/AAC 固定帧率 MP4，仅在用户启用“重编码为固定帧率”后按精确目标帧率、编码器和源指纹缓存在 `<Installation Root>\data\processing-media\v1`。只有成功历史记录仍引用它时才保留。

## 原始 VFR（Original VFR）

设置默认关闭时保留原始可变帧率媒体，不创建 CFR 缓存，也不显示回退警告。这与因 CFR 转码失败而产生的 VFR 回退不同。

## VFR 回退（VFR Fallback）

CFR 转码因空间不足、FFmpeg 失败或输出校验失败时，继续使用原始 VFR 媒体的显式结果状态。回退会在单任务和批处理行显示警告；取消或应用退出不会触发回退。

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
