# TTcut Context

## Merged Highlight Video

A single video containing the selected clips from the participating videos in
a batch, ordered by when each source was added and then by source time. It is
the batch's shared output, not an individual source video's highlight export.
_UI_: 合并集锦, 合并为一个视频

## Participating Video

A video currently set to All Rallies or Highlights in a merged batch. Each
participating video uses its own selection conditions; Analyze Only videos
do not contribute clips. A successful analysis with no matching clips is an
empty selection, not a failed video.
_UI_: 参与剪辑的视频

## Analysis Model

An immutable checkpoint bundled with the application and verified by filename,
size, and SHA-256 before packaging.

## BlurBall Analysis Mode

The execution route recorded in analysis provenance. New bundled BlurBall
analyses always use `full`, a single whole-video pass at confidence 0.30.
Legacy requests may use `two_stage`; this is no longer a user setting.

## Candidate Rally

A Rally produced by the stage-one pass of a two-stage analysis. It is used only
to construct refinement intervals and is never returned as final analysis data.

## Refinement Interval

The closed time interval produced by expanding a Candidate Rally by 0.75 seconds
on both sides, clamping it to the source duration, and taking the union of
overlapping or touching intervals. Stage-two results are retained only when the
center-frame timestamp belongs to one of these intervals.

## Final Analysis Result

The records returned to the UI. Hybrid schema v3 includes final rallies,
positive Board Counts, valid Bounce Event Times and Excluded Fragments.
Historical v1/v2 results keep their original semantics. In legacy two-stage
mode the returned records come only from the stage-two trajectory.

## Ball Model Profile

The ball-recognition route recorded on every new analysis. Bundled
`blurball_v1` is the default. Explicit local development `tracknet_v1` remains
on request v4 and continuous visibility; it is not a bundled alternative and
does not use hybrid filtering or Board Counts. A profile is never changed silently.
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
end and After-rally time. Only historical bounce-event results add one fixed
closing second; hybrid and continuous results do not. Selected Custom Rally
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

The platform-specific local environment that executes analysis. Windows uses a separately managed Python/PyTorch environment; macOS uses the bundled Core ML models and native analysis helper.

## Installation Root

The Windows-specific stable user-selected folder that owns one TTcut installation and its managed
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

## 预览副本（Playback Preview）

仅用于界面播放的兼容媒体，可从原始媒体或处理媒体生成。它保留对应时间位置，但不作为分析输入、导出输入或历史源身份；删除它不会删除原始媒体、处理媒体或用户导出文件。
_Avoid_: 处理媒体、分析源

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

## 回合识别方式（Rally Recognition Method）

将 Source-frame Trajectory 划分为可剪辑 Rally 的算法标识，不再是设置项。
Windows/Python 路径的新 BlurBall 固定使用 `hybrid_motion_bounce`；macOS 原生
worker 在实现该算法前仍固定使用 `continuous_visibility`。历史 `bounce_events`、
`continuous_visibility` 仍原样读取。展示和导出必须使用结果记录的实际方式。
_Avoid_: Analysis Mode, highlight tier

## 落台判定（Bounce Events）

历史 Rally Recognition Method。其 Rally 带有正整数 Board Count 与
Bounce Event Times；精彩筛选使用板数阈值 `3 / 5 / 7`。

## 连续可见（Continuous Visibility）

以可见帧迟滞状态机识别 Rally 的方式。它固定使用完整单阶段分析并跳过落台检测；
先按首个和最后一个可见帧形成候选，再以归一化的水平往返/横跨运动剔除回合间传球；
只有间隔和边界位移都受限的合格候选才桥接短遮挡。结果不含 Board Count 或
Bounce Event Times。

## 精彩档位（Highlight Tier）

“精彩回合”的选择准则，不是 Rally Recognition Method 或 Analysis Mode。连续可见
结果按 `end_time_seconds - start_time_seconds` 严格大于阈值的累计时长档位选择：
短回合、相持、长相持。

## 融合回合识别（Hybrid Motion Bounce）

Windows/Python 路径中新 BlurBall 的唯一识别方式 `hybrid_motion_bounce`。连续运动
负责候选定位，落点只辅助筛除无效片段和统计板数，不以漏检作为分割证据。结果
schema v3 采用严格 `bounce_count > 3 / 5 / 7` 精彩筛选；导出原始间隔严格小于
3 秒才合并。用户前后余量仍可重新包含无效画面，但不恢复被排除的落点。macOS
原生 worker 尚未实现本节算法，当前结果仍为 schema v2 `continuous_visibility`。

## 连续运动候选（Motion Candidate）

通过现有可见性迟滞、运动筛选和遮挡桥接的时间区间；不同于旧两阶段的
Candidate Rally，不触发二次推理，也不保证最终保留。

## 无效片段（Excluded Fragment）

从候选中删除的源时间半开区间 `[start, end)`，终点为最后被删源帧的下一时间戳。
重叠区间合并，保存各原因及证据；普通 UI 不展示，仅结果和开发验收报告保留。

## 死球弹跳簇（Dead Bounce Cluster）

至少三次检测落点、相邻间隔不超过 1 秒，且间隔、图像空间反弹高度、离开速度中
至少两项在每一步均下降至少 15% 的最大连续子序列。从第一跳到最后一跳整体删除。
缺失指标不参与命中；重新加速不否决，不能用球台半区或球网位置判断。

## 传球片段（Slow Transfer）

由既有慢速运动证据识别的移动段，即使没有落点仍可删除；邻近持球、停顿不属于
该无效片段。新回合不会撤销已经确认的传球筛除。

## 最终回合（Final Rally）

候选减去无效片段后的有效连通区间。分割右侧必须独立满足运动启动条件并回溯到
该运动段首个真实可见帧。按有效落点重算 Board Count；零板整个区间删除并记录
`zero_bounce_rally`，不能删除有效回合内部的零落点子窗口。
