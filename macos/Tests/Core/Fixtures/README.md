Deterministic cross-language domain fixtures belong here. Real video acceptance is deferred.

`pr115-source-time.json` is the decompressed upstream
`worker/tests/fixtures/hybrid-source-120-converted30.json.gz` at commit
`7526dcd3b87de7cd440f1ccb1dadea60030ba222` (PR #115). It contains 120 seconds of
cached Windows DirectML detections from a 30 fps conversion and the reviewed motion
cores / pause times. The native regression replays those same observations through
Swift continuous visibility. It is not evidence of new Core ML inference accuracy
or of the unavailable original 120 fps recording.
