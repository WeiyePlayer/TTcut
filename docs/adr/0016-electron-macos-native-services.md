# Electron macOS with native analysis and media services

Status: accepted. Supersedes the SwiftUI application choice in ADR 0013 and the Sparkle/local-update delivery choice in ADR 0015; ADR 0014's media fidelity requirements remain applicable.

The macOS application retains the existing Electron/React desktop UI and shared editing rules. Swift remains responsible for Core ML analysis and native media processing through versioned subprocess protocols; Electron owns tasks, export intervals, history, cache references and window lifetime. This preserves the established UI while reusing the already tested native models and media implementation, without maintaining a second interface or shipping a Python runtime.

The first delivery targets macOS 15+ and arm64, bundles one offline runtime, and produces local ad-hoc signed app/DMG/ZIP artifacts. It has no production update feed or automatic installer. SwiftUI sources remain historical reference; its data is separate from Electron's Application Support/TTcut-Electron data. Closing the window hides it; explicitly quitting cancels active work only after the existing confirmation.

Production macOS updates are a separate decision and must follow [Electron’s macOS signing requirements](https://www.electronjs.org/docs/latest/api/auto-updater/). Local ad-hoc signing does not establish production update readiness.
