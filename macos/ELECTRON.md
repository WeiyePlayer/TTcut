# Electron macOS build

The primary Mac application now uses the existing Electron UI. The Xcode SwiftUI app is retained only as a historical reference. Native development uses Swift Package Manager; it does not build the SwiftUI app or Sparkle.

BlurBall defaults to FP16 with CPU/Neural Engine, four asynchronous predictions and four prefetched windows, including both full and two-stage analysis. Postprocessing consumes predictions in frame order. Table remains FP32 CPU. Existing FP32 Core ML history stays readable. See [acceptance and measured limits](../docs/performance/macos-fp16-adoption-2026-09-05.md).

When upgrading existing local FP32 assets, regenerate and compile BlurBall before staging:

```sh
macos/.venv/bin/python macos/scripts/convert_models.py BlurBall
xcrun coremlcompiler compile macos/Resources/Models/BlurBall.mlpackage macos/Resources/Models/compiled
```

Staging rejects a compiled BlurBall model without FP16 computation. Conversion uses a separate FP16 tensor tolerance (`atol=0.005`, `rtol=0.01`); it is a numerical screening check, not a guarantee of unchanged rally boundaries. Table retains its FP32 tolerance.

```sh
npm run build:native:mac
npm run start:mac
npm run package:mac
npm run make:mac
```

Run on an Apple Silicon Mac with Xcode command-line tools, the repository's existing Node dependencies, `macos/Vendor/native`, and the compiled BlurBall/Table models. `macos/scripts/bootstrap.py`, native dependency/model preparation scripts and their lock files remain the reproducible asset preparation route; Python is a development dependency only. `stage-macos-runtime.py` builds both helpers, stages only their media libraries/models, rewrites install names, checks arm64, signs helpers and writes an integrity manifest. Runtime binaries are separate from ASAR and Electron's own media libraries.

Forge packages the application. `make-macos.mjs` signs the assembled Electron app and invokes the existing electron-builder v26 with a separate Mac configuration and publishing disabled. Output is `out/TTcut-darwin-arm64/TTcut.app`, DMG and ZIP packages, and `latest-mac.yml` under `out/make/macos/arm64/`. `--skip-native` reuses a staged runtime; use only when native source/assets have not changed. `--app-only` omits DMG/ZIP and update-metadata generation.

```sh
npm run typecheck
npm run test:mac
npm run test:native:mac
macos/.venv/bin/python macos/scripts/convert_models.py all --verify-only
npm run verify:mac
npm run verify:mac:ui
python3 scripts/verify-macos-bundle.py out/TTcut-darwin-arm64/TTcut.app
python3 scripts/verify-macos-delivery.py
```

The Electron verifier generates synthetic media, uses the built application and real Core ML/media helpers, and writes isolated user data, screenshots and results under `output/electron-macos/run-*`. It also uses explicitly labeled controlled nonempty history for UI interactions. It does not imply real-match accuracy. An optional app path verifies a relocated bundle. The standard `--user-data-dir` switch isolates test data from the default `~/Library/Application Support/TTcut-Electron`; development uses its `development` subdirectory.

The UI verifier additionally uses the existing development-only file-dialog fixtures and real native services to cover batch manual recovery, cancellation/retry, background processing and explicit quit. `verify:mac:ui` runs after packaging, which prepares the `.vite` application entry. The packaged verifier tests the shipping preload API with browser networking offline; no runtime dependency is downloaded.

Windows-specific tests and tools retain Windows behavior. macOS execution cannot establish a green Windows-native release. Local signing is ad-hoc; production signing/notarization/updates remain deferred.

The pre-migration asset backup is `/Users/weiye/DOS/TTcut-backups/swiftui-macos-20260904/manifest.json`; source changes are preserved on `backup/swiftui-macos-20260904`. Neither is uploaded automatically.

For an independent archive test, extract the ZIP outside the checkout and pass that app path to `verify-electron-macos.mjs`. `TTCUT_VERIFY_OUTPUT` places all fixtures and test data outside the checkout too. `TTCUT_VERIFY_OFFLINE_SANDBOX=1` adds a process-scoped OS sandbox denying outgoing internet (loopback remains available for debugging), verified by a rejected socket connection. macOS prohibits Chromium sandbox reinitialization inside this outer sandbox, so this diagnostic mode adds `--no-sandbox` only to the test invocation; the normal shipped application retains its default sandbox. Run both modes and report them separately. No host network setting is changed.
