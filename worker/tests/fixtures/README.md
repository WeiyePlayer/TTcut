# Continuous visibility motion fixtures

These gzip JSON files contain detector coordinates and timestamps, not video frames.
Production code never loads the fixtures or the reference XML.

- `visibility-slow-pass-c51.json.gz`: full detector output reproducing the user's 2026-09-05 12:23 analysis (44 rallies). The user identified original indices 27, 29, 34 and 41 as pure passes, and passing footage in the lead-in of 43. The test removes exactly those four candidates, requires identical raw boundaries for all 40 others, limits 43's automatic lead-in, and prevents neighboring 28/30 from padding back into deleted passes. Indices and source times are fixture annotations, never production rules.

- `visibility-motion-c51.json.gz`: full 14,847-frame BlurBall 0.30 output from the supplied `c51adbd8152598bcc5fb3aee9e0e2aed.mp4`, using the user's latest calibration. Includes source/model SHA-256 values and the 41 source intervals from the independently edited XML. Trajectory entries are `[time, visibility, x, y]`; the array index is the source frame.
- `visibility-motion-regressions.json.gz`: source-frame samples from the same video with the earlier calibration, `1-193.mp4`, `IMG_0070_TTcut_all.mp4`, and `mmexport1785752902707.mp4`. Entries are `[frame, time, visibility, x, y]`. Selected ranges retain their surrounding visibility candidates and 60 frames of boundary context. `keep` intervals must remain within one rally; `drop` intervals are visually checked passing/idle footage. These assertions cover specific regressions rather than labeling every rally in the other videos.

The primary comparison uses custom-clip behavior: 2.5 seconds before a rally and 2 seconds total after it, with midpoint resolution of overlap. Temporal precision/recall measure agreement with the supplied edit, not ball-detection accuracy. The 15/30/60 fps and scale tests exercise movement continuity separately from this fixed detector output.
