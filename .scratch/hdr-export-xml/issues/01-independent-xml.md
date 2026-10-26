# 01: XML 独立导出与准确反馈

**What to build:** XML generation succeeds independently of video conversion/scoreboard preparation; preserve each successful artifact and describe only the requested outputs with their actual failure reasons.

**Blocked by:** None (can start immediately).

**Status:** complete

- [x] XML-only dynamic HDR needs no video encoding or HDR export preflight.
- [x] Trustworthy CFR source remains usable; otherwise original-source seconds are quantized at the original rate without transcoding.
- [x] Video preparation/scoreboard failure cannot prevent XML; XML failure cannot prevent video.
- [x] Partial success retains successful files; all-failure UI and result details reflect requested artifacts and specific causes.
- [x] Public export/UI regressions cover legacy CFR, VFR/fractional rates and cancellation/cleanup.

## Evidence

- Red/green regressions demonstrated source-probe/component-validation failure retaining XML, legacy CFR fallback without media resolution, request-specific error details and renderer wording.
- Fixed NTSC source frame quantization: a cut at 600 seconds is frame 17982 at 30000/1001, rather than integer-timebase frame 18000; equivalent 60000/1001 regression passes.
- Export-start and Premiere XML tests: 22 passed, 1 preexisting Windows-host skip. App workflow tests: 42 passed. Typecheck and diff check passed.
- Real FFmpeg/ffprobe integration: original VFR XML reference without rebuilt CFR, and a fully decoded successful rally video retained after an injected XML EACCES write failure (specific writable-directory error exposed).
- Host: macOS. Real FFmpeg exercised the Windows TypeScript route with a simulated win32 platform; this is not Windows-host, installer, native macOS export, or Premiere import validation.
- Integrated real-HistoryStore regressions reproduced the missing-CFR preemption before XML. Export now uses a task-local original-source clone only after verifying the original fingerprint; default history activation remains strict, stored history stays byte-identical, and changed sources remain rejected. Real store + startExport XML-only coverage passes for both platform policies without resolving encoders.
