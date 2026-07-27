from __future__ import annotations

import math

import cv2
import numpy as np

from ttcut_worker.table_analyze import _decode_sample_frames


class FakeCapture:
    def __init__(
        self,
        frame_count: int,
        fps: float,
        *,
        expose_frame_count: bool = True,
        time_seek_preroll_frames: int = 0,
    ):
        self.frames = [
            np.full((3, 4, 3), frame_index, dtype=np.int32)
            for frame_index in range(frame_count)
        ]
        self.fps = fps
        self.expose_frame_count = expose_frame_count
        self.time_seek_preroll_frames = time_seek_preroll_frames
        self.position = 0
        self.last_read_index = -1
        self.read_indices: list[int] = []
        self.seek_operations: list[tuple[int, float]] = []
        self.released = False

    def isOpened(self):
        return True

    def release(self):
        self.released = True

    def get(self, prop):
        if prop == cv2.CAP_PROP_FPS:
            return self.fps
        if prop == cv2.CAP_PROP_FRAME_COUNT:
            return len(self.frames) if self.expose_frame_count else 0
        if prop == cv2.CAP_PROP_FRAME_WIDTH:
            return self.frames[0].shape[1]
        if prop == cv2.CAP_PROP_FRAME_HEIGHT:
            return self.frames[0].shape[0]
        if prop == cv2.CAP_PROP_POS_FRAMES:
            return self.position
        if prop == cv2.CAP_PROP_POS_MSEC:
            return max(0, self.last_read_index) / self.fps * 1000.0
        return 0

    def set(self, prop, value):
        self.seek_operations.append((prop, value))
        if prop == cv2.CAP_PROP_POS_FRAMES:
            self.position = max(0, min(len(self.frames) - 1, int(round(value))))
            return True
        if prop == cv2.CAP_PROP_POS_MSEC:
            target = math.ceil(value / 1000.0 * self.fps - 1e-9)
            self.position = max(
                0,
                min(len(self.frames) - 1, target - self.time_seek_preroll_frames),
            )
            return True
        return False

    def read(self):
        if self.position >= len(self.frames):
            return False, None
        index = self.position
        self.position += 1
        self.last_read_index = index
        self.read_indices.append(index)
        return True, self.frames[index]


def video_metadata(*, frame_count: int | None, duration_seconds: float, fps: float):
    return {
        "duration_seconds": duration_seconds,
        "fps": fps,
        "frame_count": frame_count,
        "variable_frame_rate": frame_count is None,
    }


def test_sampling_seeks_to_five_fixed_frames_without_copying(monkeypatch):
    capture = FakeCapture(100, 10.0)
    monkeypatch.setattr(cv2, "VideoCapture", lambda _path: capture)
    progress = []

    samples, info = _decode_sample_frames(
        "match.mp4",
        video_metadata(frame_count=100, duration_seconds=10.0, fps=10.0),
        lambda stage, current, total: progress.append((stage, current, total)),
    )

    assert [sample[0] for sample in samples] == [0, 25, 50, 75, 99]
    assert capture.read_indices == [0, 25, 50, 75, 99]
    assert all(sample[2] is capture.frames[sample[0]] for sample in samples)
    assert info["decoded_frame_count"] == 5
    assert info["seek_count"] == 5
    assert info["copied_frame_count"] == 0
    assert progress[0] == ("table_sampling", 0, 5)
    assert progress[-1] == ("table_sampling", 5, 5)


def test_sampling_uses_duration_when_frame_count_is_missing(monkeypatch):
    capture = FakeCapture(100, 10.0, expose_frame_count=False)
    created = []

    def create_capture(_path):
        created.append(capture)
        return capture

    monkeypatch.setattr(cv2, "VideoCapture", create_capture)

    samples, info = _decode_sample_frames(
        "match.mp4",
        video_metadata(frame_count=None, duration_seconds=10.0, fps=10.0),
        lambda *_args: None,
    )

    assert len(created) == 1
    assert [sample[0] for sample in samples] == [0, 25, 50, 75, 99]
    assert capture.read_indices == [0, 25, 50, 75, 99]
    assert info["metadata_frame_count"] == 0
    assert info["decoded_frame_count"] == 5


def test_time_seek_decodes_forward_from_keyframe_preroll(monkeypatch):
    capture = FakeCapture(
        100,
        10.0,
        expose_frame_count=False,
        time_seek_preroll_frames=2,
    )
    monkeypatch.setattr(cv2, "VideoCapture", lambda _path: capture)

    samples, info = _decode_sample_frames(
        "match.mp4",
        video_metadata(frame_count=None, duration_seconds=10.0, fps=10.0),
        lambda *_args: None,
    )

    assert [sample[0] for sample in samples] == [0, 25, 50, 75, 99]
    assert capture.read_indices == [0, 23, 24, 25, 48, 49, 50, 73, 74, 75, 97, 98, 99]
    assert info["decoded_frame_count"] == len(capture.read_indices)
