# 03: macOS 自动转换与两平台验收

**What to build:** Match automatic dynamic-HDR conversion in the native macOS media exporter, including both algorithms and scoreboard handling, and record integrated media/UI acceptance evidence.

**Blocked by:** 02: Windows 动态 HDR 自动转 SDR.

**Status:** ready-for-agent

- [ ] Share DV compatibility fields and automatic source/target policy with Windows; keep old native/history payloads readable.
- [ ] Tone-map eligible dynamic HDR before overlays and validate each segment/final output as SDR across compatible and fast algorithms.
- [ ] Keep static HDR/HLG exports and analysis normalization policy unchanged.
- [ ] Exercise real HDR10+/DV samples and regress geometry/audio/timing/cancellation; distinguish real Windows evidence from host-simulated tests.
- [ ] Update design records, run two-axis integration review, fix findings and leave a focused, reviewable branch.
