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

## Post-integration review: CFR content and process diagnostics

- Red/green export regressions use a real `HistoryStore`, `startExport`, generated H.264/AAC MP4, and real FFprobe. A valid container whose video is entirely zeroed, whose video is corrupt after 30 decodable frames, or whose audio is corrupt must reference the verified original. An intact cache is copied; missing media probing falls back; cancellation during the full decode emits one cancellation event and no XML. A combined export from the corrupted cache decodes from the original and writes back the persistent history. macOS arm64 exercises its native probe and media worker; the Windows policy runs on macOS and is not Windows-host acceptance.
- The cache check fully decodes each present audio/video stream without encoding, rejects errors or missing video frames, and bounds diagnostics; there is one added full decode per stream and its performance has not been characterized. Legacy cache records have no content hash and cannot reveal a change that still decodes without errors.
- A real noisy subprocess confirms streaming HDR frame validation retains only the first 16,384 diagnostic characters, while other process calls retain their previous default behavior.
- A further review reproduced combined exports waiting for the full scan before returning their task ID, silent loss of 159 AAC samples without a decode error, and duplicated scans for XML plus video. Combined preparation now returns a cancellable task immediately; delayed IPC reply regressions cover early failure/cancellation in both batch and single-video UI. Audio sample coverage catches the truncated stream while accepting intact AAC, MP3 and ALAC. A per-task validation result is reused only while device/inode, size and modification/change times still match; changes during scan, copy or rendering are rejected. Regressions cover in-place changes, replacement, mutation during copy and copy failure with independent video success.
- Incremental review also found analysis cancellation queued before its task ID, overlapping audio frame timestamps with intact sample totals, recovery falsely adopting an existing output after preflight failure, the macOS native history probe blocking cancellation, and an original replaced during cache validation. Red/green tests now exercise each failure through the actual page or `HistoryStore`/`startExport` boundary. Source identity is rechecked immediately before artifact use/publication and before retaining a partial; a previously published independent XML remains available if video fails later.
