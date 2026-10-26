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
