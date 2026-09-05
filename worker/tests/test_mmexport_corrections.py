from __future__ import annotations

import gzip
import json
from pathlib import Path

import pytest

from ttcut_worker.blurball_rallies import blurball_visibility_rallies
from ttcut_worker.calibration import TableCalibration
from ttcut_worker.types import TrajectoryPoint
from ttcut_worker.visibility_rallies import VisibilityMotionConfig


@pytest.fixture(scope="module")
def corrected_case():
    data = json.loads(gzip.decompress(
        (Path(__file__).parent / "fixtures/visibility-mmexport-corrections.json.gz").read_bytes(),
    ))
    value = data["calibration"]
    table = TableCalibration.from_points(value["video_width"], value["video_height"], [
        value["points"][key] for key in ("top_left", "top_right", "bottom_right", "bottom_left")
    ])
    rallies = blurball_visibility_rallies(
        [TrajectoryPoint(*point) for point in data["trajectory"]], data["fps"], table,
        motion_config=VisibilityMotionConfig(data["width"], data["height"]),
    )
    clips = [[max(0, r.start_time - 2.5, r.lead_in_start_time or 0), r.end_time + 1] for r in rallies]
    for left, right in zip(clips, clips[1:]):
        if left[1] > right[0]:
            left[1] = right[0] = (left[1] + right[0]) / 2
    return data, rallies, clips


def test_user_corrections_preserve_each_reviewed_exchange_in_a_separate_clip(corrected_case):
    data, rallies, clips = corrected_case
    assert len(rallies) == len(data["cores"]) == 99
    matches = []
    for core in data["cores"]:
        start, end = core["bounds"]
        covered = [i for i, (s, e) in enumerate(clips) if s <= start + 1e-6 and e >= end - 1e-6]
        assert len(covered) == 1, (core, covered)
        matches.append(covered[0])
    assert len(set(matches)) == 99


def test_deleted_passes_and_returned_ball_prefix_do_not_return_through_padding(corrected_case):
    data, _, clips = corrected_case
    for start, end in data["negative"]:
        assert not any(s < end and e > start for s, e in clips), (start, end)


def test_unreported_rallies_keep_their_observed_boundaries(corrected_case):
    data, rallies, _ = corrected_case
    changed = set(map(int, data["splits"])) | set(data["drops"]) | {data["trim_prefix"], data["reviewed_tail"]}
    for index, (start, end) in enumerate(data["baseline"], 1):
        if index in changed:
            continue
        matched = [r for r in rallies if r.start_time < end and r.end_time > start]
        assert len(matched) == 1, index
        assert [matched[0].start_time, matched[0].end_time] == pytest.approx([start, end], abs=1e-6)
