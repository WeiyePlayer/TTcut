# macOS keyframe-seek export verification — 2026-09-06

## Scope

- Base HEAD: `27c163088e0376b30f365c92410709e348333f85`
- Host: MacBook Air, Apple M5 (10 CPU cores), 16 GB memory
- Code changes: input-side seek for macOS fast-segmented export; automatic FFmpeg/x264/x265/filter threading
- Excluded: UI changes, hardware encoding, preset/CRF changes, analysis changes
- Packaged app: `out/TTcut-darwin-arm64/TTcut.app`

## Real analyzed-video export

- Source: `/Users/weiye/Documents/mmexport1785752902707.mp4`
- Existing analysis ID: `3aa02215-1bd0-4cd6-a9dd-34f2ed861b60`
- Selection: bounce count `> 7`, pre-roll `2.5 s`, post-roll `1 s`
- Selected rallies: `15`; merged export segments: `14`
- Start: `2026-09-06T02:07:31.638Z`
- Completion: `2026-09-06T02:09:57.564Z`
- Measured wall time: `145.636145833 s` (`2 min 25.636 s`)
- Target duration: `211.1740000000002 s`
- Validated video duration: `211.204511 s`
- Duration drift: `+0.03051099999979101 s` (allowed `0.9676666666666667 s`)
- Effective export rate: `1.4500x` real time
- Output: `/Users/weiye/Documents/mmexport1785752902707_TTcut_highlight_2.mp4`
- Output size: `68,449,926 bytes`
- Output SHA-256: `6750cde7eb4e720331fabcd1575c1dfcf61fcf91b7f69e2c76ec076e90b6804f`
- Output media: HEVC Main, 1920x1080, `yuv420p`, VFR, AAC stereo 48 kHz

## Previous-output comparison

The previous run used the same source, analysis, target duration (`211.174 s`) and
14 export segments. Its task log began at `2026-09-05T13:35:09.699Z`; the final
file creation timestamp was `2026-09-05T13:46:32Z`. This makes the old wall time
approximately `682.301 s`. The filesystem timestamp has one-second resolution, so
the old value is approximate; the new value above is measured with a monotonic clock.

- Approximate full-export speed-up: `4.68497x`
- Approximate wall-time reduction: `536.665 s` (`8 min 56.665 s`, `78.66%`)
- Old output: `/Users/weiye/Documents/mmexport1785752902707_TTcut_highlight.mp4`
- Old/new decoded-video SSIM: `1.000000` for Y, U, V and All
- Old/new decoded-audio SHA-256: `efadcdae96d0cd9f5219922bc22338ed5a14ba3dd9cb2eeab1e42bcb125fb3f8`
- Old/new stream counts: 6,352 video frames and 9,919 audio frames each
- Packet check: zero non-increasing DTS values for both video and audio in both outputs

## Verification gates

- Native Swift tests: 23 passed, including fast/compatible export, VFR,
  HDR10/HLG, 8/10-bit, H.264/HEVC, stereo/5.1 and synthetic 8K coverage.
- macOS Electron Vitest: 16 passed.
- TypeScript typecheck: passed.
- Packaged application signing verification: passed.
- Packaged Electron verification: 18 checks passed, including native Core ML,
  combined/rally/XML export, HDR10, HLG, VFR, cancellation and history recovery;
  evidence directory: `output/electron-macos/run-wZy4tl`.
- The new real output completed through the packaged Electron application using a
  copied existing history record; no new analysis was run and the real history was
  not modified.
