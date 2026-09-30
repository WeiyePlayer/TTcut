"""Local-only bridge to the selected fine-tuned Small model and decoder.

The source project is imported, never copied, trained, or modified. Stdout is
TTcut JSONL; diagnostic output belongs on stderr.
"""
from __future__ import annotations

import contextlib
import copy
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import traceback
import time
import uuid

from .mobilenet_sampling import SUPPORTED_SAMPLING_FPS, video_arrays

CHECKPOINT_SHA256 = "22f0d7639106e5997c77e76d948f1b11848cd6af7efd6fbf75d3f19e97c982ed"
CONFIG_SHA256 = "47eca8435f29ec56ea0d40ab229b6f7eb3453924ba78d954c1cf6da988bdff17"
SAMPLING_FPS = 6


class SmallError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def validate_request(value: object) -> dict:
    try:
        if not isinstance(value, dict) or set(value) - {"sampling_fps"} != {
            "schema_version", "task_id", "video_path", "video_metadata", "device"
        } or value["schema_version"] != 6:
            raise ValueError("schema")
        uuid.UUID(value["task_id"])
        if type(value.get("sampling_fps", SAMPLING_FPS)) is not int or value.get("sampling_fps", SAMPLING_FPS) not in SUPPORTED_SAMPLING_FPS:
            raise ValueError("sampling_fps")
        if value["device"] not in {"auto", "cuda", "cpu"}:
            raise ValueError("device")
        if not isinstance(value["video_path"], str) or Path(value["video_path"]).suffix.lower() not in {".mp4", ".mov"}:
            raise ValueError("video_path")
        metadata = value["video_metadata"]
        if not isinstance(metadata, dict) or metadata["path"] != value["video_path"]:
            raise ValueError("video_metadata")
        for key in ("duration_seconds", "fps", "width", "height"):
            number = metadata[key]
            if isinstance(number, bool) or not isinstance(number, (int, float)) or not math.isfinite(number) or number <= 0:
                raise ValueError(key)
    except (ValueError, TypeError, KeyError, AttributeError) as exc:
        raise SmallError("INVALID_REQUEST", "Invalid Small analysis request.") from exc
    return value


def resources(root: Path) -> tuple[Path, dict]:
    checkpoint = root / "huji_student/runs/manual_p3_20260930_epoch1/best.pt"
    config = root / "config/rally_decoder_small_epoch1_refit_6fps_20260930_balanced.json"
    for file, expected in ((checkpoint, CHECKPOINT_SHA256), (config, CONFIG_SHA256)):
        if not file.is_file():
            raise SmallError("SMALL_RESOURCE_MISSING", f"Missing Small resource: {file}")
        if digest(file) != expected:
            raise SmallError("SMALL_RESOURCE_CHANGED", f"Frozen Small resource changed: {file}")
    return checkpoint, json.loads(config.read_text(encoding="utf-8"))


def temporal_profile(config: dict, fps: int) -> tuple[dict, dict]:
    """Retain seconds-based settings and identify the fitted sampling rate.

    Source decode integrates log scores / fps, so switch/transition penalties
    must NOT be scaled. At 30 Hz samples are pooled at the fitted decoder rate.
    At 1-12 Hz use one real sample per decoder step, without inventing 30 Hz scores.
    """
    if type(fps) is not int or fps not in SUPPORTED_SAMPLING_FPS:
        raise ValueError("Small sampling fps must be an integer from 1 to 12, or 30")
    effective = copy.deepcopy(config)
    training_fps = config.get("fit_sampling_fps", 30)
    refitted = config.get("checkpoint_calibration_status") == "refitted_for_pinned_finetuned_checkpoint"
    if fps != training_fps:
        if fps != 30:
            effective["analysis_fps"] = float(fps)
        suffix = f"-{fps}fps-transfer-from-{training_fps}-v1" if refitted else f"-{fps}fps-transfer-v1"
        effective["model_id"] = config["model_id"] + suffix
    effective_hash = (CONFIG_SHA256 if fps == training_fps else hashlib.sha256(
        json.dumps(effective, sort_keys=True, separators=(",", ":")).encode()).hexdigest())
    calibration_status = (f"refitted_{training_fps}fps" if fps == training_fps else
                          f"transferred_{training_fps}fps_without_refit") if refitted else (
                          "original_30fps" if fps == 30 else "transferred_30fps_without_refit")
    return effective, {
        "config_sha256": effective_hash, "base_config_sha256": CONFIG_SHA256,
        "checkpoint_calibration_status": config.get("checkpoint_calibration_status", "transferred_from_original_checkpoint_without_refit"),
        "calibration_training_fps": training_fps,
        "calibration_status": calibration_status,
        "decoder_fps": fps / max(1, round(fps / effective["analysis_fps"])),
    }


def convert_result(recognized: dict, metadata: dict, device: str, profile: dict | None = None) -> dict:
    """Keep media fps/frames separate from the actual sampled scoring grid."""
    duration = metadata["duration_seconds"]

    def phases(values):
        output = []
        for phase in values:
            end = min(phase["end_sec"], duration)
            if end > phase["start_sec"]:
                output.append(dict(phase) if end == phase["end_sec"] else
                              {**phase, "end_sec": end, "duration_sec": end - phase["start_sec"]})
        return output

    rallies = []
    for source in recognized["rallies"]:
        end = min(source["end_sec"], duration)
        if end <= source["start_sec"]:
            continue
        retained_phases = phases(source["phases"])
        play_duration = sum(max(0., min(phase["end_sec"], end)
                                - max(phase["start_sec"], source["start_sec"]))
                            for phase in retained_phases if phase["label"] == "play")
        # Serve and editing padding cannot make a short play phase eligible.
        if play_duration + 1e-9 < 2.:
            continue
        index = len(rallies) + 1
        rallies.append({
            "id": f"rally_{index:03d}", "index": index,
            "start_time_seconds": source["start_sec"], "end_time_seconds": end,
            **{key: source[key] for key in ("kind", "has_serve", "has_play", "touches_video_start", "touches_video_end")},
            "phases": retained_phases,
        })
    return {
        "schema_version": 4, "video": metadata,
        "rally_recognition": {"method": "mobilenet_small", "version": 4},
        "small_model": {
            "checkpoint_sha256": CHECKPOINT_SHA256, "config_sha256": CONFIG_SHA256,
            "decoder_id": recognized["decoder_id"],
            "preprocessing": recognized["source"]["preprocessing"],
            "engine": "pytorch", "device": device,
            "sampling_fps": recognized["fps"], "sampling_frame_count": recognized["frame_count"],
            **(profile or {}),
        },
        "segments": phases(recognized["segments"]), "rallies": rallies,
    }


def analyze(request: dict, progress, *, observer=None) -> dict:
    started = time.perf_counter()
    root = Path(os.environ.get("TTCUT_MOBILENET_ROOT", "E:/MobileNetV3-Large"))
    checkpoint, config = resources(root)
    sys.path.insert(0, str(root))
    try:
        import numpy as np
        import torch
        from rally_detection.score import load_student, infer, PREPROCESSING
        from rally_detection.scores import Scores
        from rally_detection.pipeline import recognize
    except ImportError as exc:
        raise SmallError("SMALL_RUNTIME_MISSING", f"Small source environment is incomplete: {exc}") from exc

    video = Path(request["video_path"])
    if not video.is_file():
        raise SmallError("INPUT_MOVED", "The source video is missing.")
    device_name = request["device"]
    if device_name == "auto":
        device_name = "cuda" if torch.cuda.is_available() else "cpu"
    if device_name == "cuda" and not torch.cuda.is_available():
        raise SmallError("SMALL_DEVICE_UNAVAILABLE", "CUDA is unavailable in the Small environment.")
    device = torch.device(device_name)
    torch.set_num_threads(4)
    progress("load_model", 0, 1)
    model = load_student(checkpoint, device)
    progress("load_model", 1, 1)
    original_hash = digest(video)
    fps = request.get("sampling_fps", SAMPLING_FPS)
    config, profile = temporal_profile(config, fps)
    total = max(1, round(request["video_metadata"]["duration_seconds"] * fps))
    frames = video_arrays(video, fps)
    scoring_started = time.perf_counter()
    inference_seconds = 0.
    chunks, batch = [], []
    count = 0
    try:
        for frame in frames:
            batch.append(frame)
            if len(batch) == 64:
                inference_started = time.perf_counter()
                chunks.append(infer(model, batch, device))
                inference_seconds += time.perf_counter() - inference_started
                count += len(batch)
                batch.clear()
                progress("analysis", count, max(count, total))
        if batch:
            inference_started = time.perf_counter()
            chunks.append(infer(model, batch, device))
            inference_seconds += time.perf_counter() - inference_started
            count += len(batch)
        progress("analysis", count, max(count, total))
    finally:
        frames.close()
    scoring_seconds = time.perf_counter() - scoring_started
    if not chunks:
        raise SmallError("ANALYSIS_FAILED", "Video contains no decoded frames.")
    if digest(video) != original_hash:
        raise SmallError("INPUT_MOVED", "Source video changed during inference.")
    progress("postprocess", 0, 1)
    sequence = Scores(np.concatenate(chunks), fps, {
        "checkpoint_sha256": CHECKPOINT_SHA256, "preprocessing": PREPROCESSING,
        "source_sha256": original_hash, "video_path": str(video),
    })
    decoding_started = time.perf_counter()
    recognized = recognize(sequence, config)
    result = convert_result(recognized, request["video_metadata"], device_name, profile)
    progress("postprocess", 1, 1)
    if observer is not None:
        observer(sequence, recognized, {
            "scoring_seconds": scoring_seconds, "inference_seconds": inference_seconds,
            "decoding_seconds": time.perf_counter() - decoding_started,
            "analysis_seconds": time.perf_counter() - started,
            "cuda_peak_allocated_bytes": torch.cuda.max_memory_allocated() if device_name == "cuda" else 0,
        })
    return result


def main() -> int:
    output = sys.stdout
    task_id = "00000000-0000-0000-0000-000000000000"

    def emit(event):
        print(json.dumps({"task_id": task_id, **event}, ensure_ascii=False, allow_nan=False), file=output, flush=True)

    def progress(stage, current, total):
        emit({"type": "progress", "stage": stage, "current": current, "total": total,
              "percent": min(100., current / total * 100) if total else 0.})

    try:
        request = validate_request(json.loads(sys.stdin.readline()))
        task_id = request["task_id"]
        with contextlib.redirect_stdout(sys.stderr):
            result = analyze(request, progress)
        emit({"type": "result", "data": result})
        return 0
    except Exception as exc:
        traceback.print_exc(file=sys.stderr)
        emit({"type": "error", "code": getattr(exc, "code", "ANALYSIS_FAILED"),
              "message": str(exc), "recoverable": True})
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
