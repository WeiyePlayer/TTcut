# Automatically tone-map compatible dynamic HDR for single-source exports

Single-source video exports automatically convert HDR10+ and Dolby Vision
profile 8 with an explicitly HDR10-compatible (8.1) or HLG-compatible (8.4)
base layer to limited-range BT.709, 8-bit 4:2:0 H.264. This supersedes ADR 0018's
blanket dynamic-HDR rejection for these exports: preserving dynamic metadata
through re-encoding is still unsupported, but a real SDR conversion provides a
usable result without adding an export option or confirmation. Unknown or
incompatible Dolby Vision remains an actionable failure rather than being
interpreted as ordinary PQ or HLG.

The source's transfer function is linearized before floating-point Hable tone
mapping and BT.709 gamut/transfer conversion; changing color labels alone is not
a conversion. Source properties remain distinct from the expected output, and
every encoded segment and final output is validated against that output.
Tone mapping precedes SDR scoreboard overlays, disables stream-copy shortcuts,
and removes HDR side data. Existing SDR, HDR10/HLG preservation, analysis CFR
normalization and multi-source batch fidelity decisions remain unchanged.

Premiere XML describes source references and cut times independently of video
encoding. XML never requires HDR conversion or rebuilding a CFR video: use a
trustworthy available CFR source, otherwise the original material and its own
frame-rate quantization of the existing cut times in seconds. Preparation and
failures belong to the requested artifact, so a video failure cannot discard a
successfully written XML, and feedback cannot claim that an unrequested output
failed.

Compatibility information is based on Dolby's
[profile descriptions](https://ott.dolby.com/browser_test_kit/help_files/topics/r_resources.html).
Tone mapping follows FFmpeg's
[linear-light requirements](https://ffmpeg.org/ffmpeg-filters.html#tonemap).
