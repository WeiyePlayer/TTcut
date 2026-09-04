# Native macOS app and Core ML-only inference

Status: partially superseded by [ADR 0016](0016-electron-macos-native-services.md) for the application UI and local Electron delivery. Original decision retained below.

The macOS port uses SwiftUI with small AppKit surfaces and a separate native analysis worker. Existing BlurBall and table-model weights and network behavior are preserved and converted to Core ML; Python remains a development reference, not a shipping fallback. This separates UI/task lifetimes and avoids installing an analysis environment on end-user machines while keeping Windows independently maintained.
