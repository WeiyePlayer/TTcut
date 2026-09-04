# TTcut for macOS

Native SwiftUI application for Apple Silicon, deployment target macOS 15.0. The Windows application stays at the repository root; this implementation is isolated in `macos/`. Its source behavior is frozen at Windows commit `b9e359b3b7ea113dd5b23f203b03e53fb7690d88` (1.2.10), not the later online release.

## Development

The verified development host is an M5 Mac with macOS 26.6.2, Xcode 26.6 and Python 3.11.16. Building for macOS 15 does not establish that it has been executed on macOS 15. Open `TTcut.xcodeproj`, select the `TTcut` scheme and `My Mac`. No Apple Developer account is required for the local ad-hoc build.

Install Xcode and its command-line tools, Python 3.11, XcodeGen 2.46+, CMake, Ninja, autoconf, automake, libtool and pkg-config. Homebrew can provide the development tools:

```sh
brew install python@3.11 xcodegen cmake ninja autoconf automake libtool pkgconf
cd macos
python3.11 scripts/bootstrap.py
```

Bootstrap verifies the original checkpoint hashes, builds a macOS 15 arm64 media runtime from pinned sources, converts and checks both models, compiles their Core ML resources and generates the Xcode project. These downloads happen on the developer machine. The installed app has no component installation or download function. `Vendor/`, `.venv/`, `.tools/`, `.build/`, compiled models and `output/` are generated and ignored by Git.

`requirements-conversion.lock` pins Python dependencies. `native-sources.lock.json` and `scripts/build_native_dependencies.py` pin native inputs. The Sparkle archive is pinned in `scripts/prepare_sparkle.py`. Reproducibility here means pinned sources and repeatable validation; Xcode/Core ML compilation and signing are not claimed to produce byte-identical archives across machines or SDKs.

## Architecture

| Component | Responsibility |
|---|---|
| `Sources/App` | SwiftUI navigation, calibration, batch, history, settings and custom timeline; an AppKit AVPlayerView provides playback |
| `Sources/Core` | Typed domain data, timeline constraints, original bounce/ROI rules, history, FCP7 XML |
| `Sources/Media` | Asynchronous native subprocesses, FFprobe metadata/timestamps, two export strategies, VFR processing media and disposable previews |
| `Sources/Worker` | One native analysis process per task; Core ML inference and JSONL progress/result protocol |
| `Sources/NativeBridge` | FFmpeg decoded BGR frames, HDR inference tone mapping and OpenCV preprocessing/heatmap components |

The app bundles exactly one FFmpeg/ffprobe runtime. It contains x264, x265 with 8/10-bit support and zimg. All executables and dynamic libraries are arm64 and are resolved inside the application. No Python, PyTorch runtime, Node, Homebrew runtime, TrackNet checkpoint or Windows executable is shipped.

BlurBall uses FP32 Core ML with CPU/GPU; the table model uses FP32 Core ML on the CPU. The table model's GPU token matching exceeded the fixed numeric tolerance on the verification host, so CPU is the verified shipping path. The original architecture and weights are retained; conversion adapts graph operations, not learned parameters. Python is only the development reference.

HDR-to-SDR frames and compatibility preview proxies are used for inference/display only. Export operates on the original or explicitly recorded CFR processing media, preserving supported bit depth, HEVC, color and static HDR metadata. Dynamic HDR (Dolby Vision/HDR10+) is rejected explicitly. Fast segmented export remains the default; compatible export remains available to the service and tests without a new product setting. Very short HEVC outputs disable B-frame reordering to avoid invalid DTS values observed when x265 flushes fewer than five frames.

## Local data

`~/Library/Application Support/TTcut/` holds settings, versioned history records/covers, processing-media cache and rolling diagnostic logs. History records include the original file identity, processing-media provenance, calibration, analysis mode, model hashes, detected rallies and export folder. The index is rebuildable; malformed records are moved to `history/quarantine`.

Deleting history preserves original and exported videos. Unreferenced app-owned CFR cache directories can be reclaimed; an editor/prepared batch retains a lease while using one. Preview proxies live separately under `~/Library/Caches/TTcut/preview`. Manual/custom drafts are session-only. Windows history import and automatic shutdown are not included.

## Validation commands

From `macos/`, after bootstrap:

```sh
TTCUT_NATIVE_TESTS=1 swift test
xcodebuild -project TTcut.xcodeproj -scheme TTcut -configuration Debug -derivedDataPath .build/xcode build
.venv/bin/python scripts/local_update_test.py
```

The native test suite generates only synthetic video. Tests without `TTCUT_NATIVE_TESTS=1` skip media integration, so that invocation alone is not a complete gate. Model comparisons can be repeated using `.venv/bin/python scripts/convert_models.py all --verify-only`.

Application workflow checks invoke the app's callbacks, real worker and media services, using isolated test data. This does not replace mouse/keyboard testing:

```sh
TTCUT_UI_TEST_ROOT="$PWD/output/workflow-state" \
TTCUT_RUN_WORKFLOW_TESTS="$PWD/output/workflow-test" \
.build/xcode/Build/Products/Debug/TTcut.app/Contents/MacOS/TTcut
```

Use fresh test directories per run. Read `output/workflow-test/workflow.json`; process exit alone is not the assertion result. Rendering QA uses `TTCUT_RENDER_SNAPSHOTS`, `TTCUT_SNAPSHOT_VIDEO` and an isolated `TTCUT_UI_TEST_ROOT`. Its fixture records do not represent real detections, and bitmap snapshots do not capture the AVPlayer surface.

The `TTcutUITests` Xcode target tests navigation, manual four-corner calibration and custom timeline controls. macOS may request local authentication for the test runner. Complete that system prompt on the Mac before running:

```sh
xcodebuild -project TTcut.xcodeproj -scheme TTcut -derivedDataPath .build/xcode \
  -destination 'platform=macOS,arch=arm64' test
```

Do not change system protections to run the tests. The test runner alone has development entitlements; the shipping app does not inherit them.

## Packaging and updates

```sh
.venv/bin/python scripts/build_release.py
```

This archives the Xcode Release app, copies it outside the checkout into a path with spaces, audits every Mach-O file, exercises the bundled tools/models with a restricted PATH, launches the Release app, and builds/verifies an HFS+ DMG. It writes `output/SHA256SUMS` and machine-readable reports. It never uploads or publishes anything.

The app is locally ad-hoc signed and is not notarized. Copy it from the DMG to Applications. For a first-launch block, use Apple's documented per-app Privacy & Security flow; no script disables Gatekeeper. See [Apple's instructions](https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unknown-developer-mh40616/mac).

This account-free build disables hardened runtime for its own targets so ad-hoc framework loading does not require a Team ID. It does not change system protections. Developer ID/hardened runtime configuration can be introduced separately when a certificate is available.

Sparkle 2.9.6 is integrated, but the production feed and public key are intentionally unset, and the UI says updates are not configured. `local_update_test.py` exercises a real isolated signed update, installation and relaunch, plus rejection of a wrong EdDSA signature. Temporary private keys remain in ignored `.tools/update-test-keys/`, never in the app, repository or release assets. See [Sparkle documentation](https://sparkle-project.org/documentation/).

GitHub delivery targets a new draft release in `WeiyePlayer/TTcut`. Publishing remains manual. See `VERIFICATION.md` for actual results and limits; real match/8K/HDR material, real NLE XML import, macOS 15 execution and Developer ID/notarization are not claimed as verified.

`scripts/assemble_evidence.py` packages selected reports and own-view screenshots after all gates. Preserve the native/Windows test logs with their documented filenames, run UI tests with `-resultBundlePath output/UITests.xcresult`, and export the summary using `xcrun xcresulttool get test-results summary --path output/UITests.xcresult > output/verification/ui-tests.json`. The evidence script reads the latest workflow report, verifies the DMG hash and refuses failed gates. Run `shasum -a 256 -c SHA256SUMS` from `output/`, where the checksum file's relative asset names resolve.
