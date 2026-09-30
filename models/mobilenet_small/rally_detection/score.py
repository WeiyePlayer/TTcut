"""Run the selected fine-tuned MobileNetV3-Small on cached frames or a new video."""

from __future__ import annotations

import argparse
import csv
import io
import json
import subprocess
import tempfile
import time
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from torch.utils.data import DataLoader, Dataset

from huji_student.common import FPS, STUDENT_HEIGHT, sha256_file
from huji_student.train import IMAGENET_MEAN, IMAGENET_STD, build_model
from .scores import CLASSES, Scores


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CHECKPOINT = ROOT / "huji_student/runs/manual_p3_20260930_epoch1/best.pt"
PREPROCESSING = "full_frame_cv2_area_height256_jpeg95_pil_rgb_imagenet_v1"


def load_student(checkpoint: Path, device: torch.device):
    with torch.serialization.safe_globals([torch.torch_version.TorchVersion]):
        saved = torch.load(checkpoint, map_location="cpu", weights_only=True)
    if (tuple(saved["classes"]) != CLASSES
            or saved["config"]["model"] != "torchvision.mobilenet_v3_small"
            or saved["config"]["student_height"] != STUDENT_HEIGHT):
        raise ValueError("Expected the height-256 MobileNetV3-Small serve/play/other checkpoint")
    model = build_model(pretrained=False)
    model.load_state_dict(saved["model"], strict=True)
    return model.to(device).eval()


def image_array(image: Image.Image) -> np.ndarray:
    return np.array(image.convert("RGB"), dtype=np.uint8)


def infer(model, arrays, device):
    batch = torch.as_tensor(np.stack(arrays), device=device).permute(0, 3, 1, 2).float() / 255
    mean = batch.new_tensor(IMAGENET_MEAN).view(1, 3, 1, 1)
    std = batch.new_tensor(IMAGENET_STD).view(1, 3, 1, 1)
    with torch.inference_mode():
        return torch.softmax(model((batch - mean) / std), dim=1).cpu().numpy()


class CachedFrames(Dataset):
    def __init__(self, root, rows):
        self.root, self.rows = root, rows

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, index):
        row = self.rows[index]
        path = self.root / row["image_path"]
        raw = path.read_bytes()
        import hashlib
        if hashlib.sha256(raw).hexdigest() != row["image_sha256"]:
            raise ValueError(f"Cached image changed: {path}")
        with Image.open(io.BytesIO(raw)) as image:
            if image.size != (int(row["student_width"]), STUDENT_HEIGHT):
                raise ValueError(f"Incorrect cached image size: {path}")
            return image_array(image)


def cache_dataset(data_root: Path, output: Path, checkpoint: Path, batch_size: int,
                  workers: int, splits: tuple[str, ...]) -> None:
    with (ROOT / "data/splits/videos.csv").open(encoding="utf-8-sig", newline="") as stream:
        selected = {r["relative_path"] for r in csv.DictReader(stream) if r["split"] in splits}
    inventory = json.loads((data_root / "inventory.json").read_text(encoding="utf-8"))
    items = [v for v in inventory["videos"] if v["relative_path"] in selected]
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    torch.set_num_threads(4)
    model = load_student(checkpoint, device)
    digest = sha256_file(checkpoint)
    for item in items:
        destination = output / (item["video_id"] + ".npz")
        csv_path = data_root / "per_video" / (item["video_id"] + ".csv")
        provenance = {"checkpoint_sha256": digest, "source_sha256": item["source_sha256"],
                      "preprocessing": PREPROCESSING, "frame_manifest_sha256": sha256_file(csv_path)}
        if destination.exists():
            existing = Scores.load(destination)
            if any(existing.metadata.get(k) != v for k, v in provenance.items()):
                raise ValueError(f"Stale score cache: {destination}")
            print(f"SKIP {item['relative_path']}", flush=True)
            continue
        with csv_path.open(encoding="utf-8-sig", newline="") as stream:
            rows = list(csv.DictReader(stream))
        for index, row in enumerate(rows):
            if (int(row["frame_index"]) != index + 1 or row["source_sha256"] != item["source_sha256"]
                    or abs(float(row["time_sec"]) - index / FPS) > 1e-5):
                raise ValueError(f"Invalid cached frame timeline: {csv_path}")
        started = time.perf_counter()
        loader = DataLoader(CachedFrames(data_root, rows), batch_size=batch_size,
                            num_workers=workers, shuffle=False)
        chunks = [infer(model, batch.numpy(), device) for batch in loader]
        sequence = Scores(np.concatenate(chunks), FPS, {**item, **provenance,
                          "checkpoint": str(checkpoint.resolve()), "score_source": "student_cached_jpeg",
                          "elapsed_sec": time.perf_counter() - started})
        sequence.save(destination)
        print(f"SCORED {item['relative_path']} {len(sequence.values)} frames "
              f"{sequence.metadata['elapsed_sec']:.1f}s", flush=True)


def video_arrays(video: Path):
    # These are exactly the student's labeling preprocessing steps, without ncnn.
    import cv2
    probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                            "-show_entries", "stream=width,height", "-of", "json", str(video)],
                           check=True, capture_output=True, text=True)
    info = json.loads(probe.stdout)["streams"][0]
    width, height = int(info["width"]), int(info["height"])
    target_width = max(1, round(width * STUDENT_HEIGHT / height))
    command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-xerror", "-nostdin",
               "-noautorotate", "-threads", "1", "-filter_threads", "1", "-i", str(video),
               "-map", "0:v:0", "-vf", "setpts=PTS-STARTPTS,fps=30", "-fps_mode", "passthrough",
               "-an", "-sn", "-dn", "-f", "rawvideo", "-pix_fmt", "bgr24", "pipe:1"]
    with tempfile.TemporaryFile() as errors:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=errors)
        try:
            size = width * height * 3
            while True:
                parts, remaining = [], size
                while remaining:
                    part = process.stdout.read(remaining)
                    if not part:
                        break
                    parts.append(part)
                    remaining -= len(part)
                if not parts:
                    break
                if remaining:
                    raise ValueError("Truncated decoded video frame")
                frame = np.frombuffer(b"".join(parts), dtype=np.uint8).reshape(height, width, 3)
                resized = cv2.resize(frame, (target_width, STUDENT_HEIGHT), interpolation=cv2.INTER_AREA)
                ok, encoded = cv2.imencode(".jpg", resized)
                if not ok:
                    raise RuntimeError("Student JPEG encoding failed")
                with Image.open(io.BytesIO(encoded.tobytes())) as image:
                    yield image_array(image)
            if process.wait() != 0:
                errors.seek(0)
                raise RuntimeError(errors.read().decode(errors="replace"))
        finally:
            process.stdout.close()
            if process.poll() is None:
                process.kill()
            process.wait()


def score_video(video: Path, checkpoint: Path = DEFAULT_CHECKPOINT, batch_size: int = 64) -> Scores:
    if batch_size < 1:
        raise ValueError("batch_size must be positive")
    video = video.resolve()
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    torch.set_num_threads(4)
    model = load_student(checkpoint, device)
    source_hash = sha256_file(video)
    chunks, batch = [], []
    frames = video_arrays(video)
    started = time.perf_counter()
    try:
        for frame in frames:
            batch.append(frame)
            if len(batch) == batch_size:
                chunks.append(infer(model, batch, device))
                batch.clear()
        if batch:
            chunks.append(infer(model, batch, device))
    finally:
        frames.close()
    if not chunks:
        raise ValueError("Video contains no decoded frames")
    if sha256_file(video) != source_hash:
        raise ValueError("Source video changed during inference")
    return Scores(np.concatenate(chunks), FPS,
                  {"video_path": str(video), "source_sha256": source_hash,
                   "checkpoint_sha256": sha256_file(checkpoint), "checkpoint": str(checkpoint.resolve()),
                   "preprocessing": PREPROCESSING, "score_source": "student_source_video",
                   "device": str(device), "elapsed_sec": time.perf_counter() - started})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--video", type=Path)
    source.add_argument("--cache-dataset", type=Path)
    parser.add_argument("--checkpoint", type=Path, default=DEFAULT_CHECKPOINT)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--workers", type=int, default=0)
    parser.add_argument("--splits", nargs="+", choices=("train", "val"), default=["train", "val"])
    args = parser.parse_args()
    if args.video:
        if args.output.exists():
            raise FileExistsError(args.output)
        result = score_video(args.video, args.checkpoint, args.batch_size)
        result.save(args.output)
        print(json.dumps({**result.metadata, "frames": len(result.values)}, ensure_ascii=False, indent=2))
    else:
        cache_dataset(args.cache_dataset, args.output, args.checkpoint,
                      args.batch_size, args.workers, tuple(args.splits))


if __name__ == "__main__":
    main()
