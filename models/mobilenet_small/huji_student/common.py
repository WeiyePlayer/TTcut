"""Frozen contracts shared by labeling, verification, and training."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path


HUJI_COMMIT = "82cd429ead631f9f1c42390c8c735777a4470556"
HUJI_PREPROCESS_SHA256 = "e65f28c542ea99175b1083ddf686977569ce45c969396e02ce842f04f8809e79"
MODEL_SHA256 = {
    "metadata.yaml": "76dd6b2cedd1cedfbc036d08ccdbb4ae0cb8c733cfb0e987b4d6e91101b284ac",
    "model.ncnn.param": "69a014f1925f07d482f7b2e037b49eea21c4ee86f8851ee1d15389088494a1a6",
    "model.ncnn.bin": "4799188816173883bfb73dbc7358d753480de9d3fa44ef66115b1c5ae5a3deab",
}
CLASSES = ("serve", "play", "other")
FPS = 30
STUDENT_HEIGHT = 256
VIDEO_EXTENSIONS = {".mp4", ".mov", ".mkv", ".avi", ".m4v", ".webm"}
FRAME_FIELDS = (
    "video_id", "relative_path", "source_sha256", "frame_index", "time_sec",
    "source_width", "source_height", "student_width", "student_height",
    "image_path", "image_sha256", "teacher_serve", "teacher_play",
    "teacher_other", "teacher_top1",
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def video_id(relative_path: str) -> str:
    return hashlib.sha256(relative_path.encode("utf-8")).hexdigest()[:16]


def verify_model(model_dir: Path) -> None:
    for name, expected in MODEL_SHA256.items():
        path = model_dir / name
        if not path.is_file():
            raise FileNotFoundError(path)
        actual = sha256_file(path)
        if actual != expected:
            raise ValueError(f"Huji model hash mismatch: {path}: {actual} != {expected}")


def atomic_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".tmp")
    temp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temp, path)
