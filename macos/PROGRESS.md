# Delivery checkpoint

Baseline: `b9e359b3b7ea113dd5b23f203b03e53fb7690d88`; branch `codex/macos-native`.

Native implementation, Core ML conversion, 21 native tests, 10 in-process application workflow checks, view rendering and actual localhost Sparkle update tests are complete. See `BEHAVIOR_PARITY.md` and `VERIFICATION.md` for the evidence and its limits.

Release archive, relocated runtime audit, read-only DMG verification and checksums are complete. Delivery uses the `codex/macos-native` branch and the draft tag `macos-v1.2.10-build.1`; public release remains a manual action. The final upload record is stored locally under `output/draft-release.json`.

External Xcode UI automation passed both tests after retrying local authentication and correcting selectors to match SwiftUI's accessibility roles. No system permissions were changed. Release dependency isolation and actual launch also passed after correcting this app's ad-hoc build configuration.

Real match/8K/HDR footage, real NLE import, macOS 15 execution, Developer ID/notarization and a production update feed remain deferred or unavailable as recorded in `VERIFICATION.md`.
