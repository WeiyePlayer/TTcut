# TTcut v1.2.5

[简体中文](release-notes-v1.2.5.md) | **English**

`v1.2.5` is a stable TTcut 1.2 release that bundles BlurBall as the default ball-localisation model and fixes a task-state race at batch-task completion.

## BlurBall as the default model

- TTcut now uses the bundled BlurBall model by default for ball localisation on both CPU and CUDA; TrackNet remains selectable in Settings.
- BlurBall, TrackNet, and table-recognition weights are included in the installer and checked by fixed file sizes and SHA-256 values before packaging, so no separate model download is required after installation.
- The old B2/Uplifting dual-model download and runtime paths have been removed. Legacy unknown model settings fall back to the supported BlurBall profile after upgrade.
- This model switch does not change table auto-calibration, shared table-region filtering, rally grouping, or clip-export boundary rules.

## Batch-task stability

- Fixed the race between releasing analysis/export task state and emitting the terminal event, which could make the next queued task fail with `TASK_BUSY`.
- Unlimited queue admission and serial heavy-job execution are retained; cancellation, failure, and successful completion still report their respective terminal states.

## Retained fixes

- v1.2.4's long CPU-only export keyframe probing, cancellation propagation, and component-setup subprocess fixes remain included.

## Scope

- This release changes the default ball model and bundled model boundary. It does not add UpliftingTableTennis/B2 weights or change account, video-upload, or telemetry behavior.
- The installer continues to use the pinned `CN=weiye` self-signed Authenticode certificate, RFC 3161 timestamping, and a signed update manifest. Windows systems that do not trust the certificate may still show Unknown Publisher or SmartScreen warnings.

## Verification

- TypeScript type checking, serial Vitest, Worker pytest, website production build, and rendered HTML tests completed.
- The official NSIS build completed, and the packaged BlurBall, TrackNet, and table-recognition weights were checked for their expected sizes and SHA-256 values.
