from __future__ import annotations

import math
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Iterator

from .errors import VideoError
from .timestamp import TimestampResolver, valid_fps
from .types import TimeSource


@dataclass(frozen=True)
class VideoInfo:
    path: Path
    width: int
    height: int
    fps: float | None
    metadata_frame_count: int | None
    decoded_frame_count: int | None
    duration: float | None
    time_source_summary: str = "not_decoded"


@dataclass(frozen=True)
class FramePacket:
    index: int
    time: float
    time_source: TimeSource
    frame_bgr: object


def _cv2():
    try:
        import cv2
    except ImportError as exc:
        raise VideoError("OpenCV is not installed.") from exc
    return cv2


def validate_mp4_path(value: str | Path) -> Path:
    path = Path(value).expanduser()
    if path.suffix.lower() != ".mp4":
        raise VideoError("Only one MP4 video is supported.")
    if not path.is_file():
        raise VideoError(f"Video file does not exist: {path}")
    return path.resolve()


def _count(value: float) -> int | None:
    return int(round(value)) if math.isfinite(value) and value > 0 else None


def probe_video(value: str | Path) -> VideoInfo:
    cv2 = _cv2()
    path = validate_mp4_path(value)
    capture = cv2.VideoCapture(str(path))
    if not capture.isOpened():
        capture.release()
        raise VideoError("The MP4 video codec cannot be decoded.")
    fps_raw = float(capture.get(cv2.CAP_PROP_FPS))
    fps = fps_raw if valid_fps(fps_raw) else None
    width = int(round(capture.get(cv2.CAP_PROP_FRAME_WIDTH)))
    height = int(round(capture.get(cv2.CAP_PROP_FRAME_HEIGHT)))
    frame_count = _count(float(capture.get(cv2.CAP_PROP_FRAME_COUNT)))
    ok, frame = capture.read()
    capture.release()
    if not ok or frame is None or width <= 0 or height <= 0:
        raise VideoError("The MP4 video is empty or unreadable.")
    duration = frame_count / fps if frame_count and fps else None
    return VideoInfo(path, width, height, fps, frame_count, None, duration)


class StreamingVideoReader:
    def __init__(self, value: str | Path):
        self.info = probe_video(value)
        self.decoded_frame_count = 0
        self.last_time = 0.0
        self.last_interval = 1.0 / self.info.fps if self.info.fps else None
        self.sources: set[TimeSource] = set()

    def __iter__(self) -> Iterator[FramePacket]:
        cv2 = _cv2()
        capture = cv2.VideoCapture(str(self.info.path))
        if not capture.isOpened():
            raise VideoError("The MP4 video cannot be reopened for analysis.")
        resolver = TimestampResolver(self.info.fps)
        index = 0
        try:
            while True:
                ok, frame = capture.read()
                if not ok or frame is None:
                    break
                timestamp = resolver.resolve(index, capture.get(cv2.CAP_PROP_POS_MSEC))
                if index and timestamp.seconds > self.last_time:
                    self.last_interval = timestamp.seconds - self.last_time
                self.decoded_frame_count = index + 1
                self.last_time = timestamp.seconds
                self.sources.add(timestamp.source)
                yield FramePacket(index, timestamp.seconds, timestamp.source, frame)
                index += 1
        finally:
            capture.release()
        if not self.decoded_frame_count:
            raise VideoError("No frames were decoded.")

    def final_info(self) -> VideoInfo:
        return replace(
            self.info,
            decoded_frame_count=self.decoded_frame_count,
            duration=self.last_time + (self.last_interval or 0.0),
            time_source_summary=",".join(sorted(self.sources)),
        )

