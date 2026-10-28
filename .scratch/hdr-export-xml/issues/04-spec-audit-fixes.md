# 04: HDR／XML Spec 审计修复

**What to build:** Fix the six confirmed Spec gaps and HEVC parameter-set retry risk identified by the integration audit. Preserve independent artifacts, validated SDR output and backward-compatible histories.

**Blocked by:** None.

**Status:** implementation complete; integrated review and platform acceptance pending.

- [x] Probe CFR cache properties and fall back only to the original path whose stored source identity was checked; preserve seconds and quantize XML against the referenced source rate.
- [x] Publish validated combined exports even if history update fails; update the original persisted record without requiring the absent CFR cache.
- [x] Permit XML when media is unavailable, allow deselecting a checked unavailable video option, preserve published artifacts on non-cancellation failures, and make export logging non-fatal.
- [x] Reject residual static/dynamic HDR metadata from every frame of converted SDR segments and final output with bounded-memory, cancellable scans.
- [x] Retry matching PPS/SPS/VPS failures once from the source beginning only for sought dynamic HDR HEVC.
- [x] Expose actual output color on combined and individual-rally results while retaining the previous compatibility field.
- [ ] Integrated code review and actual Electron acceptance.
- [ ] Windows-host acceptance and Premiere import.

## Evidence and limits

- Regression tests use real `HistoryStore`, `startExport`, App actions, FFmpeg and native media export. The cache cases include nonempty corrupt content, incompatible properties, unavailable probe, copy failure, and a mismatched unverified original path.
- A BT.709 H.264 file with mastering/content-light SEI on a frame missed by bounded sampling reproduces the validation gap; both output validators now reject it by streaming all frame side-data names.
- Tests exercise the FF Pictures HDR10+ original via `TTCUT_HDR10PLUS_INTEGRATION`, compare decoded pixels with a retag-only baseline and assert source SHA-256 is unchanged. Dolby 8.1/8.4 sources remain optional test inputs.
- The TypeScript media suite runs Windows argument paths on macOS; this is not Windows-host evidence. Native media tests run on macOS. The parent integration run records actual host, media, Electron and platform limits in `../validation.md`.
