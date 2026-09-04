# Analysis history and local delivery boundaries

Status: partially superseded by [ADR 0016](0016-electron-macos-native-services.md) for the application UI and local Electron delivery. Original decision retained below.

Mac history persists analysis outcomes and their media provenance, not a custom editing project. Session-only drafts and non-destructive history removal match the Windows baseline. Updater behavior is implemented and tested locally, while production feeds, Developer ID and notarization are deferred. Release artifacts may be uploaded only as drafts; real-footage acceptance is explicitly deferred rather than counted as successful verification.
