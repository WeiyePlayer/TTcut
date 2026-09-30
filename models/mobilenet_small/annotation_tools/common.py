from __future__ import annotations

import csv
import hashlib
import json
import re
import shutil
import subprocess
from fractions import Fraction
from pathlib import Path
from typing import Iterable


VIDEO_EXTENSIONS = {
    ".mp4",
    ".mov",
    ".mkv",
    ".avi",
    ".m4v",
    ".webm",
    ".mts",
    ".m2ts",
}

ROI_FIELDS = (
    "group_id",
    "representative_video_id",
    "representative_relative_path",
    "roi_status",
    "x1",
    "y1",
    "x2",
    "y2",
    "notes",
)


def find_executable(name: str) -> str:
    executable = shutil.which(name)
    if not executable:
        raise RuntimeError(f"Required executable was not found on PATH: {name}")
    return executable


def parse_fraction(value: str | None) -> float:
    if not value or value == "0/0":
        return 0.0
    return float(Fraction(value))


def stable_video_id(relative_path: str) -> str:
    normalized = relative_path.replace("\\", "/").casefold()
    return "vid_" + hashlib.sha1(normalized.encode("utf-8")).hexdigest()[:12]


def _slug(value: str) -> str:
    value = re.sub(r"[^0-9A-Za-z\u4e00-\u9fff]+", "_", value).strip("_")
    return value[:48] or "video"


def infer_group_id(relative_path: str) -> str:
    path = Path(relative_path)
    match = re.match(r"^(match\d+)_", path.stem, flags=re.IGNORECASE)
    if match and any(part.casefold() == "racketvision" for part in path.parts):
        return "racketvision_" + match.group(1).casefold()
    digest = hashlib.sha1(relative_path.replace("\\", "/").casefold().encode("utf-8")).hexdigest()[:6]
    return f"source_{_slug(path.stem)}_{digest}"


def probe_video(path: Path, ffprobe: str | None = None) -> dict[str, object]:
    ffprobe = ffprobe or find_executable("ffprobe")
    command = [
        ffprobe,
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "format=duration,format_name,size:stream=codec_name,width,height,pix_fmt,avg_frame_rate,r_frame_rate,duration,nb_frames",
        "-of",
        "json",
        str(path),
    ]
    completed = subprocess.run(command, check=True, capture_output=True, text=True, encoding="utf-8")
    payload = json.loads(completed.stdout)
    streams = payload.get("streams") or []
    if not streams:
        raise ValueError(f"No video stream found: {path}")
    stream = streams[0]
    fmt = payload.get("format") or {}
    duration = fmt.get("duration") or stream.get("duration")
    if duration is None:
        raise ValueError(f"No duration found: {path}")
    avg_rate = str(stream.get("avg_frame_rate") or "0/0")
    real_rate = str(stream.get("r_frame_rate") or "0/0")
    return {
        "duration_sec": float(duration),
        "width": int(stream["width"]),
        "height": int(stream["height"]),
        "avg_frame_rate": avg_rate,
        "real_frame_rate": real_rate,
        "avg_fps": parse_fraction(avg_rate),
        "real_fps": parse_fraction(real_rate),
        "codec": str(stream.get("codec_name") or ""),
        "pixel_format": str(stream.get("pix_fmt") or ""),
        "container": str(fmt.get("format_name") or ""),
        "frame_count": str(stream.get("nb_frames") or ""),
        "size_bytes": int(fmt.get("size") or path.stat().st_size),
    }


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def write_csv(path: Path, rows: Iterable[dict[str, object]], fieldnames: Iterable[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(fieldnames), extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)
    temporary.replace(path)


def load_roi_groups(path: Path) -> dict[str, dict[str, str]]:
    if not path.exists():
        return {}
    return {row["group_id"]: row for row in read_csv(path)}


def validate_roi(row: dict[str, str], require_approved: bool = True) -> tuple[float, float, float, float]:
    status = row.get("roi_status", "")
    if require_approved and status not in {"APPROVED_FULL", "APPROVED_CROP"}:
        raise ValueError(f"ROI is not approved for group {row.get('group_id')}: {status or 'missing'}")
    try:
        x1, y1, x2, y2 = (float(row[name]) for name in ("x1", "y1", "x2", "y2"))
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError(f"Invalid ROI coordinates for group {row.get('group_id')}") from exc
    if not (0.0 <= x1 < x2 <= 1.0 and 0.0 <= y1 < y2 <= 1.0):
        raise ValueError(f"ROI coordinates must satisfy 0 <= x1 < x2 <= 1 and 0 <= y1 < y2 <= 1: {row}")
    return x1, y1, x2, y2
