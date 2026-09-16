from __future__ import annotations

from dataclasses import replace
import gzip
import json
from pathlib import Path

import pytest

from ttcut_worker.tracknet_motion import refine_tracknet_candidates
from ttcut_worker.types import TrajectoryPoint
from ttcut_worker.visibility_rallies import VisibilityRallySummary

with gzip.open(Path(__file__).parent / 'fixtures/tracknet-motion-reviewed.json.gz', 'rt') as source:
    CASES = json.load(source)['cases']


def run_case(case, *, scale=1.0, offset=0.0):
    points = [replace(TrajectoryPoint(**p), x=p['x'] * scale, y=p['y'] * scale,
                      time=p['time'] + offset) for p in case['points']]
    candidates = [replace(VisibilityRallySummary(**r), start_time=r['start_time'] + offset,
                          end_time=r['end_time'] + offset) for r in case['candidates']]
    original = list(points), list(candidates)
    result = refine_tracknet_candidates(points, candidates, case['fps'],
        width=case['width'] * scale, height=case['height'] * scale,
        table_bottom=case['table_bottom'] * scale)
    assert (points, candidates) == original
    return result


@pytest.mark.parametrize('case', CASES, ids=lambda case: case['name'])
def test_reviewed_real_video_motion(case):
    result = run_case(case)
    assert len(result) == case['expected_count']
    for start, end in case['live_intervals']:
        assert any(r.start_time <= start and r.end_time >= end for r in result), 'Live play was cut or split'
    for start, end in case['excluded_intervals']:
        assert not any(min(r.end_time, end) > max(r.start_time, start) for r in result), 'Dead ball retained'
    if case['name'] == '1-193_separate_serves_after_pass':
        assert result[1].lead_in_start_time >= 211.8  # Export padding must not restore the pass.


@pytest.mark.parametrize('case', CASES, ids=lambda case: case['name'])
def test_motion_is_invariant_under_image_scale_and_time_origin(case):
    original = run_case(case)
    transformed = run_case(case, scale=2.0, offset=100.0)
    assert [(r.start_frame, r.end_frame) for r in transformed] == [(r.start_frame, r.end_frame) for r in original]


def test_missing_ball_alone_cannot_bridge_a_long_gap():
    case = next(c for c in CASES if c['name'] == 'mm_continuous_offscreen_exchange')
    first, second = case['candidates']
    without_gap_observations = dict(case, points=[p for p in case['points']
        if p['time'] <= first['end_time'] or p['time'] >= second['start_time']])
    assert len(run_case(without_gap_observations)) == 2


def test_no_new_split_when_only_missing_observations_separate_play():
    case = next(c for c in CASES if c['name'] == 'mm_continuous_offscreen_exchange')
    first, second = case['candidates']
    combined = dict(first, end_frame=second['end_frame'], end_time=second['end_time'])
    case = dict(case, candidates=[combined], points=[p for p in case['points']
        if p['time'] <= first['end_time'] or p['time'] >= second['start_time']])
    result = run_case(case)
    assert len(result) == 1
    assert result[0].start_time == combined['start_time']
    assert result[0].end_time == combined['end_time']
