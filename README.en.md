# TTcut

[简体中文](README.md) | **English**

TTcut is a local automatic table-tennis video cutter for players and enthusiasts. It locates the ball, detects bounce events and valid rallies, then exports edited clips using the selected cutting mode.

Videos, analysis results, and history stay on the local computer. TTcut requires no account, uploads no video, and collects no telemetry. The default analysis models are included in the installer; the optional new ball models are downloaded on demand. The analysis runtime and media-processing components require an internet connection during initial setup; after installation, analysis, preview, and cutting can run offline.

> The current stable release is `v1.2.2` for Windows x64. TTcut no longer blocks startup according to a Windows build-number allowlist.

## Download and installation

1. Download `TTcut-1.2.2-x64-Setup.exe` from the [TTcut v1.2.2 Release](https://github.com/WeiyePlayer/TTcut/releases/tag/v1.2.2).
2. Run the installer, choose the installation root, and decide whether to create a desktop shortcut. Application files are written under `<root>\app`; large runtimes, downloads, and import staging are stored under `<root>\data\components`. A Start menu shortcut is always created.
3. On first launch, open Settings and install the Analysis component and Video processing component after reviewing the prompts.

The Analysis component detects an NVIDIA GPU automatically and falls back to CPU if CUDA installation or self-test fails. The Video processing component reads media information, cuts and joins segments, and validates exported files.

## What's new in v1.2.2

- Fixed A/V drift caused by accumulated encoded-duration rounding in multi-segment AAC exports. Concat now uses measured encoded-segment durations and safely pads audio to the video endpoint.
- x264 segment encoding avoids equal or regressing decode timestamps at concat boundaries, reducing `EXPORT_CONCAT_FAILED` cases.
- If a playable file already exists when a later validation or bookkeeping step fails, TTcut retains it under a collision-safe name instead of deleting it.
- Single-video and batch workflows mark such results as exported with a warning, expose the error code, technical details, and logs, and continue with remaining videos.
- Unreadable output and explicit cancellation remain failure or cancellation states. This release does not change analysis models, dynamic ROI, trajectories, rally grouping, or bounce-count recognition.

See the [v1.2.2 release notes](docs/release-notes-v1.2.2.en.md) for the complete details.

## Usage

### 1. Select a video and calibrate the table

- In Automatic cutting, select or drag in one `.mp4` or `.mov` file.
- Automatic calibration samples the video and detects the table by default.
- Switch to manual calibration when adjustment is needed, then select a clear frame on the timeline.
- Click the four corners in this order: top-left, top-right, bottom-right, bottom-left. Drag numbered points to correct them.
- Confirm that the points do not overlap, cross the frame boundary, or use the wrong order, then start analysis.

![Four-corner table calibration](docs/images/calibration.png)

### 2. Wait for local analysis

The analysis page reports real processing progress. A running task can be cancelled. When closing TTcut during a task, choose whether to exit, minimize, or keep the task running. If no valid rally is found, recalibrate the table or choose another video.

### 3. Choose a cutting mode

- **All rallies**: export every valid rally.
- **Highlights**: retain rallies whose bounce-based count exceeds the selected threshold of 3, 5, or 7.
- **Custom**: select rallies individually and preview each one.

![Choose a cutting mode](docs/images/cutting-modes.png)

### 4. Set boundaries and export

Choose the pre-roll and post-roll duration in Settings, return to the cutting mode, and export. Results are stored beside the source video:

- `match.mp4` or `match.mov` becomes `match_ttcut.mp4`.
- Existing names are preserved; TTcut uses `match_ttcut_2.mp4`, `match_ttcut_3.mp4`, and so on.
- After export, play the result directly or reveal it in File Explorer.

### 5. History

Completed analyses are saved locally with a first-frame thumbnail, including analyses that found zero rallies. If the source video has not moved or changed, opening a history entry returns directly to cutting mode without rerunning analysis.

### 6. Batch tasks

Select multiple MP4 or MOV files in Batch tasks. On entry, TTcut automatically calibrates each video in list order; successful items wait in the ready state. A failed item shows “Calibration failed / Calibrate manually” on its cover and opens the reusable four-point calibration page when clicked. Completing calibration returns to the same queue with its state preserved. “Start analysis and cutting” processes ready items only, so items waiting for manual calibration do not block the rest. Outputs are stored beside their source videos.

## Cutting rules

- Raw rallies separated by less than 5 seconds are merged into one cut group; a gap of exactly 5 seconds or more starts a new group.
- Pre-roll and post-roll settings are applied once per cut group.
- One additional closing second is retained after the last rally in each group before the selected post-roll is applied, clamped to the source duration.
- Expanded segments that overlap are merged again to avoid duplicate footage.

## Analysis component

The installer includes fixed rally-analysis and table-recognition models. The on-demand runtime provides Python 3.12.13, PyTorch 2.12.1, NumPy, OpenCV, and the minimal Worker used for:

- frame-by-frame TrackNet ball localisation;
- automatic or manual table calibration and coordinate mapping;
- three-frame/five-frame bounce detection and timestamp deduplication;
- rally grouping based on bounce events.

The runtime is installed under `<root>\data\components`. CPU, CUDA 12.6, and CUDA 13.2 variants are supported.

## Video processing component

The managed FFmpeg/ffprobe component validates MP4/MOV metadata, rotation, and streams; creates and joins cut segments; preserves or normalises source orientation as required; and validates the final output. Safe boundaries use stream copy; other cuts use accurate re-encoding.

OpenH264 remains the default encoder. An optional x264 component can be downloaded and imported from Settings for high-resolution re-encoding. A valid x264 installation uses `libx264`, `veryfast`, and `CRF 18`; invalid or missing x264 falls back to OpenH264. Lower-resolution videos are never upscaled.

## Run from source

Requirements: Windows x64, Node.js 22, and npm 10.

```powershell
npm install
npm start
```

Validation and packaging:

```powershell
npm run typecheck
npm test
python -m pytest worker/tests -q
npm run test:e2e
npm run verify:release
npm run make
npm run make:official
```

`npm run make` creates unsigned NSIS artifacts under `out\make\nsis\x64`. `npm run make:official` applies the official signing and release verification gates and emits the pinned-key-signed `update-manifest.json` and `update-manifest.json.sig`.

## Known limitations

- The single-video workflow handles one MP4 or MOV at a time; Batch tasks accepts multiple MP4/MOV files and runs a serial “calibrate first, then process” queue with manual recovery for failed items.
- The displayed count is a bounce-event proxy, not a ground-truth paddle-hit count.
- Windows x64 is the primary supported build. Removing the Windows build-number gate does not guarantee that every old Windows version, Windows Server edition, x86 system, or ARM64 system can run all dependencies.

More implementation and release documentation is available under [`docs`](docs).

## Support

Feedback, bug reports, and feature requests are welcome through GitHub Issues or WeChat `m2924931661`.

Support the project on [Afdian](https://ifdian.net/a/weiye).
