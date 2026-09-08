"""Full source-time inference frozen before tuning against the three user XMLs.

These tests preserve unadjusted *raw* boundaries, not padded XML cut times.
Corrections reviewed in the source video are explicit exceptions, not silently
promoted to user-approved labels. No model, video decoder or local path needed.
"""
import gzip
import json
from pathlib import Path

import pytest

from ttcut_worker.calibration import TableCalibration
from ttcut_worker.hybrid_rallies import hybrid_motion_rallies
from ttcut_worker.types import TrajectoryPoint
from ttcut_worker.visibility_rallies import VisibilityMotionConfig


@pytest.fixture(scope='module')
def replays():
    outputs = {}
    for name in ('193', 'side', 'diagonal'):
        path = Path(__file__).parent / 'fixtures' / f'hybrid-xml-{name}.json.gz'
        data = json.loads(gzip.decompress(path.read_bytes()))
        c = data['calibration']
        calibration = TableCalibration.from_points(c['video_width'], c['video_height'], c['points'])
        points = [TrajectoryPoint(frame, time, visible, x, y, 'blurball', confidence,
                                  time_source=data['time_source'])
                  for frame, time, visible, x, y, confidence in data['trajectory']]
        result = hybrid_motion_rallies(points, data['fps'], calibration,
                                       motion_config=VisibilityMotionConfig(**data['motion_config']))
        outputs[name] = data, result
    return outputs


def covering(result, start, end):
    return [r for r in result.rallies if r.start_time <= start + .001 and r.end_time >= end - .001]


@pytest.mark.parametrize('name,unchanged_count', [('193', 33), ('side', 12), ('diagonal', 67)])
def test_unadjusted_raw_boundaries_remain_exact(replays, name, unchanged_count):
    data, result = replays[name]
    exceptions = {row['index'] for row in data['video_reviewed_extensions']}
    if name == 'diagonal':
        # Original v1 XML indices 70/71 became v2 history 69/70. The
        # subsequent explicit user correction joins these two pieces.
        exceptions.update({70, 71})
    unchanged = [i for i in data['unadjusted_indices'] if i not in exceptions]
    assert len(unchanged) == unchanged_count
    for index in unchanged:
        old = data['baseline_rallies'][index-1]
        matches = [r for r in result.rallies
                   if abs(r.start_time-old['start_time_seconds']) < .001
                   and abs(r.end_time-old['end_time_seconds']) < .001]
        assert len(matches) == 1, (name, index, old)


def test_two_otherwise_unadjusted_truncations_have_explicit_video_reviewed_exceptions(replays):
    data, result = replays['diagonal']
    for row in data['video_reviewed_extensions']:
        old = data['baseline_rallies'][row['index']-1]
        matches = covering(result, old['start_time_seconds'], row['minimum_end'])
        assert len(matches) == 1
        assert matches[0].start_time == pytest.approx(old['start_time_seconds'], abs=.001)
        assert matches[0].end_time < data['baseline_rallies'][row['index']]['start_time_seconds']


@pytest.mark.parametrize('name,start,end', [
    ('193', 376.613, 383.019), ('193', 445.515, 451.654),
    ('side', 19.1666667, 24.0666667), ('side', 260.5666667, 264.4333333),
    ('diagonal', 64.6928778, 72.8211222), ('diagonal', 715.5858111, 723.6141222),
    ('diagonal', 728.8441889, 732.9416222),
])
def test_manually_joined_rally_cores_are_no_longer_split(replays, name, start, end):
    assert len(covering(replays[name][1], start, end)) == 1


@pytest.mark.parametrize('start,end', [(235.5, 237.5), (325.5, 328.0)])
def test_side_view_missing_rally_cores_are_recovered(replays, start, end):
    data, result = replays['side']
    assert not any(r['start_time_seconds'] <= start <= r['end_time_seconds'] for r in data['baseline_rallies'])
    assert len(covering(result, start, end)) == 1


def test_diagonal_slow_horizontal_false_detection_no_longer_extends_tail(replays):
    data, result = replays['diagonal']
    old = data['baseline_rallies'][38]
    assert old['end_time_seconds'] > 450
    matches = covering(result, old['start_time_seconds'], 447.5)
    assert len(matches) == 1
    assert matches[0].end_time <= 448.8


def test_strike_protection_does_not_remove_independent_side_view_pass_evidence(replays):
    _, result = replays['side']
    assert any(abs(f['start_time_seconds']-4.8666667) < .001
               and any(e['reason'] == 'slow_transfer' for e in f['evidence'])
               for f in result.excluded_fragments)


@pytest.mark.parametrize('name', ['193', 'side', 'diagonal'])
def test_replayed_counts_and_exclusions_remain_consistent(replays, name):
    data, result = replays[name]
    times = {row[0]: row[1] for row in data['trajectory']}
    valid_times = [times[frame] for frame in result.bounce_frames]
    for rally in result.rallies:
        assert rally.bounce_count > 0
        assert rally.bounce_count == sum(rally.start_time <= t <= rally.end_time for t in valid_times)
    for fragment in result.excluded_fragments:
        start, end = fragment['start_time_seconds'], fragment['end_time_seconds']
        assert not any(start <= t < end for t in valid_times)
        assert not any(r.start_time < end and r.end_time >= start for r in result.rallies)
