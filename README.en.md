# TTcut

<p align="center"><img src="public/ttcut-icon.png" alt="TTcut icon" width="160"></p>

[简体中文](README.md) | **English**

TTcut is a local automatic table-tennis video cutter for players and enthusiasts. It locates the ball, detects bounce events and valid rallies, then exports edited clips using the selected cutting mode.

Videos, analysis results, and history stay on the local computer. TTcut requires no account, uploads no video, and collects no telemetry. An internet connection is required when installing the resources needed for the first run; analysis, preview, and cutting can run offline after setup.

> The current stable release is `v1.2.9` for Windows x64.

## Download and installation

1. Download the Windows version from [TTcut Releases](https://github.com/WeiyePlayer/TTcut/releases).
2. Download the Android version from [TTcut-Mobile-Releases](https://github.com/WeiyePlayer/TTcut-Mobile-Releases/releases).
3. If GitHub downloads are slow, use the Baidu Netdisk mirror: [link](https://pan.baidu.com/s/1LXDzs74xOM1t50-IRM_Vvw?pwd=ttct), extraction code: `ttct`.
4. Run the installer, choose the installation root, and decide whether to create a desktop shortcut. Application files are written under `<root>\app`; large runtime resources, downloads, and import staging are stored under `<root>\data\components`. A Start menu shortcut is always created.
5. On first launch, open Settings, review the prompts, and install the required runtime resources.

TTcut detects an NVIDIA GPU automatically and falls back to CPU if accelerated setup or its self-test fails. Its video-processing capability reads media information, cuts and joins segments, and validates exported files.

## What's new in v1.2.9

- Settings now offers Analysis precision: Default retains the established full-video analysis, while High precision first finds candidate rallies and then runs a finer second analysis over those intervals. It takes longer.
- After calibration, variable-frame-rate video is preferentially converted to constant-frame-rate processing media for analysis, preview, cutting, and newly created XML. The original video remains the identity, calibration, and default-output source.
- If constant-frame-rate preparation runs out of space, transcoding fails, or output validation fails, TTcut shows a clear warning and continues analysis with the original variable-frame-rate video.
- Improved the rally-analysis flow and settings defaults, and fixed related progress, history, and export hand-offs.

See the [v1.2.9 release notes](docs/release-notes-v1.2.9.en.md) for the complete details.

## Contact the author on WeChat: m2924931661

Feedback, bug reports, and feature suggestions are welcome.

## Usage

### 1. Select a video and calibrate the table

- In Automatic cutting, select or drag in one `.mp4` file.
- Automatic calibration samples the video and detects the table by default.
- Switch to manual calibration when adjustment is needed, then select a clear frame on the timeline.
- Click the four corners in this order: top-left, top-right, bottom-right, bottom-left. Drag numbered points to correct them.
- Confirm that the points do not overlap, cross the frame boundary, or use the wrong order, then start analysis.
- During calibration or mode selection, use Back in the top-left title bar to choose another video.

![Four-corner table calibration](docs/images/calibration.png)

### 2. Wait for local analysis

The analysis page reports real processing progress. A running task can be cancelled. When closing TTcut during a task, choose whether to exit, minimize, or keep the task running. If no valid rally is found, recalibrate the table or choose another video.

### 3. Choose a cutting mode

- **All rallies**: export every valid rally.
- **Highlights**: retain rallies whose bounce-based count exceeds the selected threshold of 3, 5, or 7.
- **Custom**: open the dedicated timeline to select rallies individually, preview each clip, and adjust its start and end boundaries. You can also create or delete rally clips manually and choose combined MP4, independent MP4, or Premiere-importable FCP7 XML output.

![Choose a cutting mode](docs/images/cutting-modes.png)

### 4. Set boundaries and export

For All rallies and Highlights, choose pre-roll and post-roll durations in Settings. Custom mode lets you adjust each clip's start and end directly on its dedicated timeline before exporting. Custom export can retain the combined MP4 and optionally create one MP4 per rally and a Premiere-importable FCP7 XML. Results are stored beside the source video:

- `match.mp4` becomes `match_ttcut.mp4`.
- Existing names are preserved; TTcut uses `match_ttcut_2.mp4`, `match_ttcut_3.mp4`, and so on.
- After export, play the result directly or reveal it in File Explorer.

### 5. History

Completed analyses are saved locally with a first-frame thumbnail, including analyses that found zero rallies. If the source video has not moved or changed, opening a history entry returns directly to cutting mode without rerunning analysis.

### 6. Batch tasks

Select multiple MP4 files in Batch tasks. On entry, TTcut automatically calibrates each video in list order; successful items wait in the ready state. A failed item shows “Calibration failed / Calibrate manually” on its cover and opens the reusable four-point calibration page when clicked. Completing calibration returns to the same queue with its state preserved. “Start analysis and cutting” processes ready items only, so items waiting for manual calibration do not block the rest. Outputs are stored beside their source videos.

## Cutting rules

- Raw rallies separated by less than 5 seconds are merged into one cut group; a gap of exactly 5 seconds or more starts a new group.
- Pre-roll and post-roll settings are applied once per cut group.
- One additional closing second is retained after the last rally in each group before the selected post-roll is applied, clamped to the source duration.
- Expanded segments that overlap are merged again to avoid duplicate footage.

## Local analysis

The installer includes the ball- and table-recognition resources required at runtime, so model weights do not need to be downloaded separately. Local analysis is responsible for:

- automatic or manual table calibration and coordinate mapping;
- locating the ball and detecting bounce events;
- organizing valid rallies with shared table-region, timing, and rally rules;
- selecting GPU acceleration or CPU processing according to the local environment.

Runtime resources are installed under `<root>\data\components`. Models shipped with the application are checked against fixed sizes and SHA-256 values before packaging.

## Video processing

Video processing is responsible for:

- validating MP4 rotation, duration, resolution, frame rate, audio/video streams, and keyframes;
- creating and joining clips according to rally boundaries;
- using lossless copying at safe boundaries and one accurate re-encode otherwise;
- preserving resolution, orientation, aspect ratio, and color information while validating duration, audio/video synchronization, and playability.

Regular videos use the default processing configuration. An optional video-processing extension can be installed from Settings when high-resolution re-encoding is required; TTcut falls back to the default configuration if the extension is missing or damaged. Lower-resolution videos are never upscaled.

## Run from source

Requirements: Windows x64, Node.js 22, and npm 10. Install dependencies and start TTcut:

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

`npm run make` creates the current version's local unsigned installer and update metadata; it does not change the version or upload a Release. `npm run make:official` applies the official signing and release-verification gates.

Videos, model weights, and runtime resources required by the real end-to-end workflow are not distributed with the repository and must be supplied as verified local files on the test machine. The 125%, 150%, and 200% layout cases provide automated DPI regression coverage on the current machine; they are not cross-version Windows certification. Startup and pre-task checks determine system, architecture, and runtime-resource compatibility. See the [Windows compatibility policy](docs/windows-compatibility.md).

## Known limitations

- The single-video workflow handles one MP4 or MOV at a time; Batch tasks accepts multiple MP4/MOV files and runs a serial “calibrate first, then process” queue with manual recovery for failed items.
- The displayed count is a bounce-event proxy, not a ground-truth paddle-hit count.
- Windows x64 remains the primary build. Removing the Windows build-number gate does not guarantee that older Windows versions, x86 systems, or ARM64 systems can run every required dependency.

More implementation and release documentation is available under [`docs`](docs).

## Support the project

If TTcut is useful to you, contributions are appreciated. Thank you for your support.

Afdian: https://ifdian.net/a/weiye
