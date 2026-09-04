# One bundled media runtime with explicit fidelity

The macOS app bundles one arm64 FFmpeg runtime with x264 and x265 instead of user-installed component variants. Input bit depth, HEVC, HDR10/HLG and source timing are explicit probe/export contracts; inference images may be SDR but never replace export media. Dynamic HDR is rejected in this first release, rather than silently discarded. Both export algorithms remain testable, while the UI preserves the current fast-segmented behavior.
