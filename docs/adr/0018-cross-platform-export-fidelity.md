# Cross-platform export fidelity

Windows now follows the macOS media fidelity policy: HDR10/HLG and HEVC inputs
export as HEVC with `hvc1`; other SDR inputs use H.264. Both retain supported
8/10-bit depth, chroma, displayed geometry, color metadata, static mastering
display and content-light metadata, audio channels/sample rate, and VFR
timestamps. This supersedes the H.264-only media decision in ADR 0017; the
Windows analysis runtime remains unchanged. The bundled FFmpeg must provide
x264 and x265, without a user-installed encoder fallback.

ADR 0019 supersedes the following rejection for compatible single-source
dynamic-HDR exports with an automatic, explicit-in-code SDR conversion.
Faithful Dolby Vision/HDR10+ re-encoding remains unsupported on both platforms:
analysis and previews may decode the base layer, but video export rejects these
inputs before copy or re-encoding can discard their dynamic metadata. Unsupported
depths are rejected instead of silently converted. Preview proxies may tone-map
HDR to SDR H.264 and must never replace export media.

Merged Highlight Videos keep their existing common dimensions and nominal frame
rate, taken from the first participating video, and their existing common AAC
48 kHz stereo audio specification when any contributor has audio. Their
color/depth/HDR contract must match every participating clip; incompatible HDR,
SDR, depth, chroma, mastering, or color metadata is rejected instead of silently
converting the batch to 8-bit SDR. Any HEVC contributor selects HEVC for the
shared output. An empty selection does not determine the media profile.

The TS and native Swift policies share a regression fixture. Encoding uses a
reference frame rate in the encoder options while VFR keeps its filter time
base and frame durations; clearing frame duration can exclude the last frame
from MP4 playback even when the packet was written. Old Windows histories are
reprobed from the original source because their CFR copies may have already
lost HDR side data. New CFR caches use the fidelity policy and a new cache key.
