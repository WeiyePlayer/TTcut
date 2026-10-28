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
- A test-generated `testsrc2` picture with valid frame-carried T.35 HDR10+ metadata converted to SDR with full decode, all-frame HDR-side-data absence, source preservation and mean RGB difference >12 versus a tag-only baseline. This synthetic source verifies the bitstream path, not real HDR footage. Both combined two-cut and independent-rally+XML `startExport` paths passed.
- Official Dolby Vision 8.1/8.4 originals supplied by parent converted directly from the original bitstreams. Both passed SDR codec/pixel/color/fidelity validation, all-frame no-HDR-side-data checks and full decode. Retained outputs: `/tmp/ttcut-hdr-export-validation/ttcut-fidelity-PMLOVt/DV81-sdr.mp4` and `DV84-sdr.mp4`.
- Windows packaged verification script updated for successful automatic HDR10+ conversion; not executed because no Windows host is available. Native macOS implementation/visual checks belong to ticket 03.
- Python request compatibility inspected: analysis sends only the existing four timing metadata fields, so optional DV export fields do not change Python request parsing.

## Meaningful Dolby Vision frame follow-up

- The initial 0.25-second Dolby samples contain a black introduction; their earlier checks establish decoding/metadata only, not color quality.
- A new red/green regression drives actual `startExport` at source time 15 seconds with real probed keyframes. It first failed with `EXPORT_INVALID`: seeking skipped in-band HEVC parameter sets (`PPS id out of range`) and encoded no frames.
- The same segment exporter now narrowly retries from source time zero when a nonzero seek of auto-tone-mapped HEVC reports missing VPS/SPS/PPS. Cut boundaries, filters, target, validation and chosen segmented algorithm remain identical. Shared execution covers single, concatenated and independent-rally segments; batch policy stays unchanged.
- Targeted real media checks passed (3): DV8.1 fast single segment at 15..16, DV8.4 fast two segments at 15..15.5 and 16..16.5, plus HDR10+ combined/independent export regression. Both DV outputs have mean RGB >5, highlights >180, >5% colored pixels and mean difference >5 from tag-only RGB, plus SDR/no-HDR-side-data/full-decode checks.
- Current nonblack outputs for visual review: `/tmp/ttcut-hdr-export-validation/ttcut-fidelity-HG7bgm/DV81-sdr.mp4` and `DV84-sdr.mp4`. Affected export suites: 29 passed, 1 pre-existing skipped; typecheck and diff check passed. Host remains macOS running Windows code paths, not actual Windows.
