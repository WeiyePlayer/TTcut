# 03: macOS 自动转换与两平台验收

**What to build:** Match automatic dynamic-HDR conversion in the native macOS media exporter, including both algorithms and scoreboard handling, and record integrated media/UI acceptance evidence.

**Blocked by:** 02: Windows 动态 HDR 自动转 SDR.

**Status:** complete

- [x] Share DV compatibility fields and automatic source/target policy with Windows; keep old native/history payloads readable.
- [x] Tone-map eligible dynamic HDR before overlays and validate each segment/final output as SDR across compatible and fast algorithms.
- [x] Keep static HDR/HLG exports and analysis normalization policy unchanged.
- [x] Exercise real HDR10+/DV samples and regress geometry/audio/timing/cancellation; distinguish real Windows evidence from host-simulated tests.
- [x] Update design records, run two-axis integration review, fix findings and leave a focused, reviewable branch.

## Evidence

- Native TDD: a synthetic `testsrc2` source with valid frame-carried HDR10+ metadata failed with `DYNAMIC_HDR_UNSUPPORTED`, then passed with actual SDR conversion through both compatible/fast algorithms. This is a bitstream regression, not real HDR footage. The real DV probe test failed for missing compatibility data, then passed for both official 8.1 and 8.4 bitstreams.
- Real DV nonblack cuts at source seconds 15–15.5 and 16–16.5 passed on both native algorithms, with complete output decoding, H.264/8-bit/BT.709 target checks and all-frame absence of HDR side data. Mean RGB greater than 5 prevents black introductory frames from satisfying visual material coverage.
- These Dolby originals carry parameter sets in initial packets: input-side seek reproduced a missing-video failure. The fix retries the same segment from the start only on actual missing PPS/SPS/VPS decode evidence, preserving color plan and export algorithm.
- Synthetic HDR10+ decoded pixel difference from un-tone-mapped source exceeds 5 RGB levels on average; SDR white scoreboard remains above 240. Analysis normalization still rejects dynamic-HDR fidelity conversion.
- Native new media cases: 4 passed (probe, real DV, HDR10+, overlay/normalization). Targeted preservation/probe/parity suite: 10 passed (SDR/audio, HDR10/HLG, invalid dynamic HDR, VFR tail/timestamps, CFR normalization, ten-bit multichannel/rotation/SAR, cancellation, two shared policies and bounded sampling). Shared TS automatic policy: 10 passed. Typecheck and diff-check passed.
- Actual host evidence is macOS arm64 using the project's bundled FFmpeg and newly built Swift media exporter. Windows host/installer and Premiere import remain unverified; parent integration handles Electron/UI and two-axis review. ADR 0019 is already recorded on integration.
- Real DV output examples retained under `macos/output/tests/EF4DC9FB-7D16-45B1-9689-85A3759EF180/` in this ticket worktree; source originals and their official SHA-256 metadata are under `/tmp/ttcut-hdr-export-samples/`.
- Integration retained the native outputs under `output/hdr-export-xml/native/`. Actual Electron + newly built native worker passed DV8.1/DV8.4 combined SDR export, independent rally + XML export, complete decoding and real result-preview decoded-frame advancement; source hashes stayed unchanged.
- Actual custom-editor UI also passed missing-CFR/failed-draft-save XML export and both-output scoreboard font failure with retained XML and independent video failure. Evidence and limitations are in `../validation.md`.
- Two-axis review: Standards 0 findings; Spec 2 P2 renderer preparation findings, both fixed and rechecked, including the both-output fault path. Final integrated affected suite: 78 passed, 3 platform skips; typecheck and diff check passed.
