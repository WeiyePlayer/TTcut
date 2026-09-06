# Native macOS app and Core ML-only inference

Status: superseded by [ADR 0016](0016-electron-macos-native-services.md). The SwiftUI application was removed after the Electron migration; its historical implementation remains available in Git history.

The macOS port uses SwiftUI with small AppKit surfaces and a separate native analysis worker. Existing BlurBall and table-model weights and network behavior are preserved and converted to Core ML; Python remains a development reference, not a shipping fallback. This separates UI/task lifetimes and avoids installing an analysis environment on end-user machines while keeping Windows independently maintained.
