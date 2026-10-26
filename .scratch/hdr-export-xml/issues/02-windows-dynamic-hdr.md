# 02: Windows 动态 HDR 自动转 SDR

**What to build:** Export convertible HDR10+ and compatible Dolby Vision automatically as accurately tone-mapped SDR H.264, without user-facing conversion options or notices; preserve existing SDR/static-HDR behavior.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Probe and persist optional DV compatibility information; reprobe older dynamic-HDR records.
- [ ] Use a separate source/target color plan for combined and independent-rally output.
- [ ] Apply real linear floating-point Hable/BT.709 conversion before scoreboard overlay; emit limited-range 8-bit 4:2:0 H.264 without HDR side data and without stream-copy shortcuts.
- [ ] Validate against actual target properties; expose output color for preview.
- [ ] Keep incompatible/unknown DV failures actionable and retain source fidelity guards for analysis/batch paths.
- [ ] Demonstrate red/green regressions and real-bitstream pixel/metadata/decode tests; record host limitations honestly.
