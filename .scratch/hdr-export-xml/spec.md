# 动态 HDR 自动转换与 XML 独立导出

Approved scope: Windows and macOS; local tickets only. Integration branch `fix/hdr-export-xml` is based on `285fa450cd8f31fc79502cc0db5803ab8626033a` (`origin/develop`). Preserve the original checkout and its untracked macos directory.

## Required behavior

- XML source resolution/writing is independent of video source preparation, tone mapping, and scoreboard assets. Preserve successful artifacts when another output fails; report only requested outputs and independent failure reasons.
- Prefer available trustworthy CFR media for XML. Otherwise reference the original source, retaining cut boundaries in seconds and quantizing against the original rate, without transcoding for XML.
- Automatically export convertible dynamic HDR as SDR H.264 without an option, prompt, or conversion notice. Preserve current SDR, HDR10 and HLG behavior.
- Support HDR10+ with a PQ base and Dolby Vision profile 8 with an explicitly compatible HDR10 (8.1) or HLG (8.4) base layer. Persist optional DV profile/base-layer/compatibility information; reprobe legacy dynamic-HDR histories lacking it. Unsupported/unknown DV keeps an actionable failure and does not block XML.
- Separate source metadata from an internal ExportColorPlan and target metadata. Perform source-transfer linearization, floating-point Hable tone mapping, BT.709 gamut/transfer conversion, and encode limited-range 8-bit 4:2:0 H.264. Merely changing tags is forbidden.
- Convert before scoreboard overlay, disable stream copy for conversion, remove dynamic/static HDR side data, and validate every segment and final output against the target. The result preview uses actual output color metadata.
- Apply to Windows and native macOS single-source combined and independent-rally exports, including both existing native algorithms. Preserve analysis CFR-cache policy and do not expand mixed-HDR multi-source batch policy.
- No mandatory new user request fields. Maintain compatibility with existing histories and native contracts. Output results expose actual color properties; artifact errors expose requested outputs and per-output failures.
- A scoreboard score may carry optional `image_error: 'SCOREBOARD_RENDER_FAILED'` when renderer font/canvas preparation fails and XML was also requested. Main treats this as a video preparation failure and still writes XML; it must not silently export the video without its requested overlay.

## Audit remediation

- Export-only CFR selection validates the existing cache's actual CFR, frame rate, duration, geometry, audio and color against its recorded properties and decodes the complete video and any audio stream before accepting the cache. Audio verification checks frame timestamp continuity and decoded coverage as well as sample duration, with tolerances for timestamp rounding and codec priming rather than requiring exact packet counts. Decode errors, missing frames, missing/corrupt/unprobeable/mismatched files or copy failure fall back to the original only when its path matches the source identity verified by history. Recheck the persistent source's path, size and modification time before using or publishing each artifact; preserve any artifact already published independently. XML requires no encoder or new CFR transcode; the full-content check is cancellable and keeps diagnostic output bounded. The result can be reused inside one task only while file identity and change timestamps match; recheck after a copy and before/after rendering. This adds one complete decode per present stream when checking a cache, potentially slower than real time. Legacy histories lack a content hash, so syntactically valid undetected content changes cannot be proven absent.
- Register combined exports and report preparation before lengthy CFR validation, allowing cancellation before encoding. Export-only history opening defers the native cache probe to that cancellable task; ordinary history opening retains its strict validation. Terminal events delivered before the task-start IPC response are retained by the batch page, including analysis and export; pending cancellation is sent after the task ID arrives, and a specific analysis failure is not mislabeled as cancellation. The single-video page does not restore a completed task when that response arrives.
- Recovery only considers task-owned partial files and final files actually published by the task. Failed preflight must not claim an existing destination as a new output or write export history.
- Export history completion updates the original stored analysis after source identity validation; it does not re-require a missing analysis cache or persist a task-local fallback. A failed history write after the video has been validated and published yields a successful result with `EXPORT_HISTORY_UPDATE_FAILED` warning.
- A media-component failure does not preempt an XML request. Existing selected video can always be deselected. Export logging is non-fatal, including asynchronous subprocess logging; non-cancellation failures preserve published artifacts and clean up unpublished files.
- Dynamic HDR-to-SDR validation checks every output frame's HDR side-data names with bounded-memory streaming, including bounded process diagnostics, for each segment and final output, on both platforms. Ordinary SDR and HDR10/HLG retain their existing validation policy. This adds a full decode pass per validated dynamic-HDR segment/final file; performance has not been characterized.
- Missing PPS/SPS/VPS diagnostics on a sought dynamic-HDR HEVC segment trigger at most one retry from the source beginning, retaining ranges and color plan; unrelated failures and cancellation do not trigger retry.
- Combined and individual-rally results expose optional `outputColor` containing the actual output's `video_codec`, `pixel_format`, `color_range`, `color_space`, `color_transfer`, `color_primaries` and `media_fidelity`; unknown values are null. The old `outputMediaFidelity` remains supported. Preview prefers actual output color information.

## Validation and workflow

- Use implement-spec: isolated ticket worktrees/branches, TDD at existing approved public seams, merge through a merger agent, two-axis code-review, fix findings, then clean up ticket worktrees. Local issue statuses reflect completed implementation and evidence, including explicit validation limits.
- Cover XML-only, one-output failure/other-output success, legacy CFR fallback, VFR and 29.97/59.94 cut mapping, request-specific UI/errors, cancellation and cleanup.
- Use real HDR10+ and DV bitstreams; verify decoded pixels/highlights/color, full decoding, BT.709 output and absence of HDR side data. Simulated HDR metadata and tag checks alone are insufficient.
- Regress SDR, HDR10/HLG, geometry/rotation, timing/audio sync, scoreboard, single/multiple segments. Record Windows/macOS evidence separately; simulated win32 is not Windows-host evidence.
- Do not publish installers, remote issues or pull requests. Real platform checks that cannot run must be explicitly recorded as unverified.

## Tickets

1. XML independent export and accurate feedback (no blockers).
2. Windows automatic dynamic HDR to SDR (no blockers).
3. macOS automatic conversion and integrated validation (blocked by 2).
4. Audit remediation for independent artifacts, history and output-color validation (implementation based on `4dd3525c`).
