# TTcut Electron macOS migration

Decision: [ADR 0016](adr/0016-electron-macos-native-services.md). Electron source baseline: `b9e359b3b7ea113dd5b23f203b03e53fb7690d88` (1.2.10). Native/UI snapshot preserved at `e2c673323c0d5398cb900ad67b53d81925a17c0d`, branch `backup/swiftui-macos-20260904`. Implementation branch: `codex/electron-macos`.

## Behavior

- Keep Electron/React navigation, Chinese/English, calibration, full/two-stage BlurBall, all/highlight/custom modes, timeline editing, serial batch processing, history and MP4/XML outputs.
- macOS 15+, arm64. Native Core ML only: Table uses CPU; BlurBall permits CPU/GPU. Preserve source checkpoints, thresholds, preprocessing, ROI and temporal semantics. Compute configuration does not prove which hardware executed an operation.
- Bundle FFmpeg/ffprobe with x264/x265, models and native helpers. Support HEVC/10-bit/HDR10/HLG and synthetic 8K. Reject dynamic HDR. No managed-component installation or batch shutdown on Mac.
- Hide the window on close, retaining the renderer and batch state. Dock restores it. Explicit quit uses the existing cancellation confirmation.
- Store Electron history/settings under Application Support/TTcut-Electron; development and automated tests use separate directories. Do not import or modify SwiftUI/Windows history. Drafts remain session-only.

## Boundaries

Electron selects and validates final export ranges and owns filenames, XML, history, source identity and cache cleanup. `TTcutWorker` analyzes/calibrates; `TTcutMediaWorker` probes, encodes, normalizes and generates previews/covers. Both use versioned JSON requests and JSONL events with task IDs. A successful terminal event and successful process exit are both required. Mac subprocesses are managed as process groups, including cancellation escalation.

Analysis results keep the existing version-one envelope with optional native media/model provenance. Native table diagnostics use a distinct version-two variant instead of inventing Python timing or aggregation fields. Windows result shapes remain readable.

Original media owns identity and calibration coordinates. Optional CFR processing media may feed analysis/export. Disposable SDR playback previews never replace either. Media commands write to unique caller-owned staging directories; outputs become visible only after validation. Cleanup is restricted to task-owned staging and unreferenced cache paths.

## Build and verification

See [Electron macOS build instructions](../macos/ELECTRON.md) and the generated Electron verification report. The old `macos/VERIFICATION.md` describes the SwiftUI build and must not be used as evidence for this application.

Deliver local app/DMG/ZIP with SHA256 and source/build metadata. No upload, release publication, Developer ID, notarization or automatic-update acceptance is part of this stage. Real matches, real HDR viewing, sustained 8K performance, real NLE import, macOS 15 runtime execution and other chip generations remain separate acceptance items.
