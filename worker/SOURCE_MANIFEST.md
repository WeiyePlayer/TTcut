# TrackNet-only source manifest

The TTcut worker is a deliberately small derivative of the
TrackNetV3_TableTennis source at commit `40d4d26bc85802d5925ead6b1fd0ad3c6a8a84ba`.

Retained behavior:

- `tracknet/models.py`: TrackNet convolutional model only.
- `app/predictor.py`: streaming TrackNet inference only.
- `app/postprocess.py`: heatmap candidate selection only.
- `app/video_reader.py`, `app/timestamp.py`, `app/types.py`: decoding and time data.
- `app/analysis/table_calibration.py`: four-point homography.
- `app/analysis/bounce_detection.py`: calibrated bounce detection.
- `app/analysis/speed_analysis.py::group_rallies`: bounce-only grouping, extracted
  without speed or hit imports.

Explicitly excluded: InpaintNet, hit detection, speed calculation, overlay and
trajectory video rendering, CLI/WebUI code, Gradio, and all InpaintNet weights.
The upstream/local source remains unchanged.
