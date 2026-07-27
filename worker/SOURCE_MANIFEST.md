# Analysis worker source manifest

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

Automatic table calibration additionally retains the self-contained inference
model and five-frame adapter supplied as the local `table_analyze` component:

- `fixed_model.py`: SegFormer++ B2 forward inference structure only.
- `calibrate_video.py`, `predict.py`, `model_loader.py`: model loading,
  preprocessing, first/25%/50%/75%/last sampling, raw 13-keypoint extraction,
  and closest-valid-pair aggregation only.

The diagnostic image, overlay, homography, camera calibration, calibrated-video
rendering, CLI, sample inputs, outputs, caches, and `vendor/` tree are excluded.

Explicitly excluded: InpaintNet, hit detection, speed calculation, overlay and
trajectory video rendering, CLI/WebUI code, Gradio, and all InpaintNet weights.
The upstream/local source remains unchanged.

The bundled model files are staged separately from `resources/models` and are
not stored in Git or inside the staged Python worker directory.
