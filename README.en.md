# TTcut

<p align="center"><img src="public/ttcut-icon.png" alt="TTcut icon" width="160"></p>

[简体中文](README.md) | **English**

TTcut is a local automatic table-tennis video cutter for players and enthusiasts. It locates the ball, organizes valid rallies with the selected recognition method, then exports edited clips using the selected cutting mode.

Videos, analysis results, and history stay on the local computer. TTcut requires no account, uploads no video, and collects no telemetry. The Windows online installer needs a connection while installing runtime resources; the Windows full installer and macOS packages already include their runtime resources. Analysis, preview, and cutting can run offline after setup.

> The current stable release is `v1.3.0` for Windows x64 and macOS 15+ on Apple Silicon.

## Download and installation

1. For Windows x64, download either the full installer or online installer from [TTcut Releases](https://github.com/WeiyePlayer/TTcut/releases). The online installer downloads and verifies the required runtime resources during installation and needs an active connection.
2. For macOS 15+ on Apple Silicon, download the DMG from the same [TTcut Releases](https://github.com/WeiyePlayer/TTcut/releases) page. The current macOS build is ad-hoc signed and not notarized; if first launch is blocked, allow it in System Settings > Privacy & Security.
3. Download the Android version from [TTcut-Mobile-Releases](https://github.com/WeiyePlayer/TTcut-Mobile-Releases/releases).
4. If GitHub downloads are slow, use the Baidu Netdisk mirror for Windows resources: [link](https://pan.baidu.com/s/1LXDzs74xOM1t50-IRM_Vvw?pwd=ttct), extraction code: `ttct`.
5. On Windows, run the installer, choose the installation root, and decide whether to create a desktop shortcut. Application files are written under `<root>\app`; large runtime resources, downloads, and import staging are stored under `<root>\data\components`. A Start menu shortcut is always created.
6. On first Windows launch, open Settings, review the prompts, and install the required runtime resources.

TTcut detects an NVIDIA GPU automatically and falls back to CPU if accelerated setup or its self-test fails. Its video-processing capability reads media information, cuts and joins segments, and validates exported files.

## What's new in v1.3.0

- Windows: Continuous motion is now the default rally-recognition method, with improved handling for short rallies, vertical movement, between-rally passes, and waiting segments.
- Windows: Automatic calibration samples more points across the video and selects a result using stable candidates and table geometry, improving robustness in complex footage.
- macOS: the first macOS 15+ Apple Silicon desktop build includes native Core ML analysis and media runtimes. Although the interface offers Continuous motion, the current native analysis result still uses Bounce events.
- Manual calibration accepts the four table corners in any order and keeps them directly adjustable afterward.

See the [v1.3.0 release notes](docs/release-notes-v1.3.0.en.md) for the complete details.

## Contact the author on WeChat: m2924931661

Feedback, bug reports, and feature suggestions are welcome.

## Usage

### 1. Select a video and calibrate the table

- In Automatic cutting, select or drag in one `.mp4` file.
- Automatic calibration samples the video and detects the table by default.
- Switch to manual calibration when adjustment is needed, then select a clear frame on the timeline.
- Click the four table corners in any order. After all four are marked, drag the numbered points to correct them.
- Confirm that the points do not overlap or cross the frame boundary and form a sufficiently large convex quadrilateral, then start analysis.
- During calibration or mode selection, use Back in the top-left title bar to choose another video.

![Four-corner table calibration](docs/images/calibration.png)

### 2. Wait for local analysis

The analysis page reports real processing progress. A running task can be cancelled. When closing TTcut during a task, choose whether to exit, minimize, or keep the task running. If no valid rally is found, recalibrate the table or choose another video.

### 3. Choose a cutting mode

- **All rallies**: export every valid rally.
- **Highlights**: filter by the bounce-based count with Bounce events, or by duration tiers with Continuous motion.
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

The full installer includes the ball- and table-recognition resources required at runtime; the online installer downloads and verifies them during installation. Local analysis is responsible for:

- automatic or manual table calibration and coordinate mapping;
- locating the ball and organizing valid rallies with Continuous motion or Bounce events;
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
- With Bounce events, the displayed count is a bounce-event proxy, not a ground-truth paddle-hit count. Continuous motion does not display a count.
- Windows x64 remains the primary build. Removing the Windows build-number gate does not guarantee that older Windows versions, x86 systems, or ARM64 systems can run every required dependency.

More implementation and release documentation is available under [`docs`](docs).

## Support the project

If TTcut is useful to you, contributions are appreciated. Thank you for your support.

Afdian: https://ifdian.net/a/weiye
