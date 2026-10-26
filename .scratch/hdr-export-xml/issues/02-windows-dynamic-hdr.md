# 02: Windows 动态 HDR 自动转 SDR

**What to build:** Export convertible HDR10+ and compatible Dolby Vision automatically as accurately tone-mapped SDR H.264, without user-facing conversion options or notices; preserve existing SDR/static-HDR behavior.

**Blocked by:** None (can start immediately).

**Status:** complete

- [x] Probe and persist optional DV compatibility information; reprobe older dynamic-HDR records.
- [x] Use a separate source/target color plan for combined and independent-rally output.
- [x] Apply real linear floating-point Hable/BT.709 conversion before scoreboard overlay; emit limited-range 8-bit 4:2:0 H.264 without HDR side data and without stream-copy shortcuts.
- [x] Validate against actual target properties; expose output color for preview.
- [x] Keep incompatible/unknown DV failures actionable and retain source fidelity guards for analysis/batch paths.
- [x] Demonstrate red/green regressions and real-bitstream pixel/metadata/decode tests; record host limitations honestly.

## Evidence

- Public-seam red/green tests: HDR10+ segment/scoreboard args, DV probe compatibility, old-history reprobe, target-color validation, leftover mastering metadata rejection, and real spawned-process missing-filter classification.
- Focused TS suites: 53 passed, 1 pre-existing skipped; typecheck, script syntax and diff checks passed.
- Real FFmpeg media suite: 15 passed on a macOS host, exercising Windows argument/code paths through simulated `process.platform=win32`; this is NOT Windows-host or packaged-app validation.
- Real T.35 frame-carried HDR10+ converted to SDR with full decode, all-frame HDR-side-data absence, source preservation and mean RGB difference >12 versus a tag-only baseline. Both combined two-cut and independent-rally+XML `startExport` paths passed.
- Official Dolby Vision 8.1/8.4 originals supplied by parent converted directly from the original bitstreams. Both passed SDR codec/pixel/color/fidelity validation, all-frame no-HDR-side-data checks and full decode. Retained outputs: `/tmp/ttcut-hdr-export-validation/ttcut-fidelity-PMLOVt/DV81-sdr.mp4` and `DV84-sdr.mp4`.
- Windows packaged verification script updated for successful automatic HDR10+ conversion; not executed because no Windows host is available. Native macOS implementation/visual checks belong to ticket 03.
- Python request compatibility inspected: analysis sends only the existing four timing metadata fields, so optional DV export fields do not change Python request parsing.
