# 01: XML 独立导出与准确反馈

**What to build:** XML generation succeeds independently of video conversion/scoreboard preparation; preserve each successful artifact and describe only the requested outputs with their actual failure reasons.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] XML-only dynamic HDR needs no video encoding or HDR export preflight.
- [ ] Trustworthy CFR source remains usable; otherwise original-source seconds are quantized at the original rate without transcoding.
- [ ] Video preparation/scoreboard failure cannot prevent XML; XML failure cannot prevent video.
- [ ] Partial success retains successful files; all-failure UI and result details reflect requested artifacts and specific causes.
- [ ] Public export/UI regressions cover legacy CFR, VFR/fractional rates and cancellation/cleanup.
