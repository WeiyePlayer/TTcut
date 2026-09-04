# Verification record

Verification host: Apple M5 / 16 GB, macOS 26.6.2, Xcode 26.6. Source baseline: `b9e359b3b7ea113dd5b23f203b03e53fb7690d88` (1.2.10). Updated 2026-09-04.

## Passed

- Exact checkpoint size/SHA256 verification. BlurBall: `3545206c7155194ea654899d33579c88c9fd8e82c632cbdbae3b0c0ec3f2985f`; table: `160e1a9b2d0236b501dc4a4d38bbfb39315eeef6de5d8c11770452623ff102df`.
- FP32 model comparisons use `abs(error) <= 1e-4 + 1e-3 * abs(reference)` with no nonfinite output. BlurBall CPU/GPU maximum absolute error: `1.117587e-7` across three input sizes. Table CPU maximum: `2.818927e-5`. Zero tolerance violations. Table GPU failed the same tolerance, so the app uses Core ML CPU for that model.
- 21 native XCTest tests passed with media tests enabled. Coverage includes 60 Python trajectory fixtures / 240 bounces; ROI/segment/custom rules; history/index recovery, cache leases; original Python BlurBall preprocessing (2,880 floats), table preprocessing (1,029 sampled floats) and heatmap decoding; both export strategies; VFR; rotation/SAR; 10-bit SDR; stereo/5.1 audio; HDR10/HLG; H264 8K; combined 8K HEVC 10-bit HDR10; XML/manual outputs; cancellation and failure isolation.
- Extremely short HEVC output initially exposed invalid DTS on flushing the encoder. Export now disables B-frame reorder for fewer than five frames, consistently across a segmented merge. The previously failing 8K HDR test passes with the change.
- Application callback workflow passed source loading, calibration preview, real native analysis, manual clip export, history reopening with a fresh draft, preserving files on deletion, cancellation, batch failure isolation, manual batch recovery and batch result reopening. This is not external mouse/keyboard automation.
- Both external Xcode UI tests passed with zero failures: navigation, unconfigured update state, manual four-corner clicks, analysis, custom mode and adding a manual rally. The earlier local authentication error cleared on retry. Tests use the actual SwiftUI accessibility hierarchy and native mouse interaction.
- SwiftUI views were rendered and inspected in Chinese/English. Existing icon, light layout and navigation are retained. AVPlayer's native video layer is not represented by bitmap snapshots; a black video rectangle in those files does not establish playback correctness.
- Real Sparkle localhost update test passed: version 1 discovered version 2, downloaded, verified, installed and relaunched. A wrong EdDSA signature was rejected and version 1 remained installed. Production updater URL/key are unset. No test private key is shipped.
- Windows baseline TypeScript type checking passed. Original Python tests passed: 45. Running Windows Vitest on this Mac produced 233 passed, 10 failed, 20 skipped. The failures are Windows path/installation registration, Windows updater platform and PowerShell/certificate assumptions; this is not a green Windows-native regression run. Windows code was not modified.

## Final artifact audit

Release archive and DMG passed validation. All 19 Mach-O files are arm64, have deployment targets no newer than macOS 15, have app-relative/system dependencies and pass deep ad-hoc signature validation. A copy outside the checkout, in a path with spaces, launched with a restricted system-only PATH and exercised bundled FFmpeg plus both Core ML inference paths. On synthetic patterns table detection may correctly return `AUTO_CALIBRATION_FAILED`; the test checks that the table model actually ran, not that a pattern contains a real table.

The read-only DMG mounted successfully. Its app signature was verified, the signed executable/resource seal matched the Release archive, its Applications link was present and its bundled ffprobe ran.

- File: `TTcut-1.2.10-macOS-arm64-build1.dmg`
- Size: 117,532,052 bytes.
- SHA256: `d34b707b19701273f83a1fcc8758076db342c1a8e9262e011b6f7856425cd7a6`.
- Application source commit: `21f4816cd564c5b6f91c2768de277b0cc0119d62`, with no uncommitted macOS changes at packaging time. Subsequent delivery documentation does not change the app binary.
- Signature: ad-hoc, without hardened runtime/Developer ID/notarization. No production update endpoint/key is included.

## Deferred and unavailable

- The initial Release launch failed to load Sparkle because hardened runtime library validation requires a matching Team ID. The project now uses non-hardened ad-hoc signing for this account-free build. This changes this application's build configuration, not macOS system protections. The corrected Release passed the relocated launch check.
- At the user's request: no real table-tennis match footage, real 8K/HDR10/HLG footage or real NLE XML import acceptance was performed. Synthetic test patterns are not evidence of real detection accuracy, export visual quality or sustained 8K performance.
- macOS 15 runtime execution and M1–M4 hardware were not available. The deployment target and binary minimum-version audit do not replace those runtime checks.
- Developer ID signing, notarization, public release and a production update feed are out of scope. Only a GitHub draft is authorized. No performance target is claimed.

## Evidence

Build/test commands are in `README.md`. Raw local evidence is under ignored `output/verification/`, `output/workflow-test-*/`, `output/screenshots/`, `output/UITests-*.xcresult` and the corresponding `macos/*.log` files. The draft evidence archive contains selected reports and screenshots, not source videos, private keys or the Python environment. `BEHAVIOR_PARITY.md` maps implementation to the baseline.
