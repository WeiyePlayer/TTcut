from dataclasses import replace
import json
from pathlib import Path
from unittest.mock import patch

import pytest

from ttcut_worker import hybrid_rallies as hybrid
from ttcut_worker.blurball_bounce import _BounceCandidate
from ttcut_worker.blurball_rallies import _observed_exchange_times, _trim_slow_run_tail
from ttcut_worker.blurball_rallies import _is_observed_horizontal_flight
from ttcut_worker.calibration import TableCalibration
from ttcut_worker.types import TrajectoryPoint
from ttcut_worker.visibility_rallies import VisibilityMotionConfig, VisibilityRallySummary


CONFIG = VisibilityMotionConfig(analysis_width_pixels=200, analysis_height_pixels=100)
CALIBRATION = TableCalibration.from_points(200, 100, [[0, 50], [199, 50], [199, 99], [0, 99]])


def point(frame, time=None, x=100, y=20):
    return TrajectoryPoint(frame, frame / 20 if time is None else time, 1, x, y, 'blurball', 1.0)


def event(p):
    return _BounceCandidate(p, 10, 'test')


@pytest.mark.parametrize('xs,times,expected', [
    ([0, 6, 12, 18], [0, .05, .10, .15], True),
    ([18, 12, 6, 0], [0, .05, .10, .15], True),
    ([0, 0, 0, 18], [0, .05, .10, .15], False),
    ([0, 12, 6, 18], [0, .05, .10, .15], False),
    ([0, 6, 12, 18], [0, .05, .20, .25], False),
    ([0, 6, 12, 18], [0, 0, .10, .15], False),
    ([0, 6, 12], [0, .05, .10], False),
    ([0, 3, 6, 9], [0, .05, .10, .15], False),
])
def test_short_return_requires_distributed_observed_motion(xs, times, expected):
    run = [point(i, t, x=x) for i, (t, x) in enumerate(zip(times, xs))]
    assert _is_observed_horizontal_flight(run, 200, minimum_displacement_ratio=.08) is expected


def cluster(times, heights=(10, 8.5), speeds=(10, 8.5)):
    points = [point(i, t) for i, t in enumerate(times)]
    with patch.object(hybrid, '_flight_metrics', return_value=(list(heights), list(speeds))):
        return hybrid.dead_bounce_fragments([event(p) for p in points], points, 20)


@pytest.mark.parametrize('times,expected', [([0, 1], False), ([0, 1, 1.85], True), ([0, 1.001, 1.8], False)])
def test_minimum_three_and_inclusive_one_second(times, expected):
    assert bool(cluster(times)) is expected


@pytest.mark.parametrize('series,expected', [([10, 8.5], True), ([10, 8.5001], False), ([10, None], False), ([0, 0], False), ([10], False)])
def test_decay_boundary_and_missing_metrics(series, expected):
    assert hybrid._decays(series) is expected


def test_two_metrics_required_and_speed_gain_alone_is_not_a_veto():
    assert cluster([0, 1, 1.85], heights=(10, 8.5), speeds=(10, 1000))
    assert not cluster([0, 1, 1.85], heights=(10, None), speeds=(10, 1000))
    assert cluster([0, 1, 2], heights=(10, 8.5), speeds=(10, 8.5))


@pytest.mark.parametrize('opposed,strikes,expected', [
    (True, [.5], False), (True, [], True), (False, [.5], True),
])
def test_dead_cluster_protection_needs_observed_strike_and_opposed_landing_velocities(opposed, strikes, expected):
    points = [point(i, t) for i, t in enumerate([0, 1, 1.8])]
    events = [replace(event(p), before_velocity=((-4 if opposed else 4), 2), after_velocity=(4, -2))
              for p in points]
    with patch.object(hybrid, '_flight_metrics', return_value=([10, 8], [10, 8])):
        result = hybrid.dead_bounce_fragments(events, points, 20, motion_config=CONFIG, strike_times=strikes)
    assert bool(result) is expected


def test_later_strike_preserves_an_already_qualified_dead_ball_prefix():
    points = [point(i, t) for i, t in enumerate([0, 1, 1.8, 2.4])]
    events = [replace(event(p), before_velocity=(4, 2), after_velocity=(4, -2)) for p in points]
    events[-1] = replace(events[-1], before_velocity=(-4, 2))
    with patch.object(hybrid, '_flight_metrics', return_value=([10, 8, 6], [10, 8, 6])):
        result = hybrid.dead_bounce_fragments(events, points, 20, motion_config=CONFIG, strike_times=[2.1])
    assert len(result) == 1
    assert result[0]['evidence'][0]['bounce_times_seconds'] == [0, 1, 1.8]


def test_partial_exchange_requires_distributed_observations_not_a_jump_to_a_static_false_detection():
    flight = [point(i, x=x) for i, x in enumerate([0, 20, 40, 60, 80, 60, 40, 20, 0])]
    assert _observed_exchange_times(flight, 200)
    assert hybrid.observed_strike_times(flight, CONFIG)
    jump = [point(i, x=x) for i, x in enumerate([0, 0, 0, 0, 100, 100, 100, 100, 0, 0, 0])]
    assert not _observed_exchange_times(jump, 200)
    occluded = [replace(p, time=p.time + (1 if i >= 4 else 0)) for i, p in enumerate(flight)]
    assert not _observed_exchange_times(occluded, 200)


def test_inactive_horizontal_drift_only_trims_hybrid_and_keeps_short_or_vertical_motion():
    drift = [point(i, x=20+i, y=20) for i in range(25)]
    assert _trim_slow_run_tail(drift, 20, CONFIG) == (tuple(drift), False)
    assert _trim_slow_run_tail(drift, 20, CONFIG, discard_inactive=True) == ((), True)
    assert _trim_slow_run_tail(drift[:15], 20, CONFIG, discard_inactive=True)[0]
    vertical = [replace(p, y=p.y + i) for i, p in enumerate(drift)]
    assert _trim_slow_run_tail(vertical, 20, CONFIG, discard_inactive=True)[0]


def test_maximal_overlapping_clusters_are_unioned_and_last_bounce_excluded():
    fragments = cluster([0, 1, 1.8, 2.4], heights=(10, 8, 6), speeds=(10, 8, 6))
    assert len(fragments) == 1
    assert fragments[0]['start_time_seconds'] == 0
    assert fragments[0]['end_time_seconds'] == pytest.approx(2.45)
    assert fragments[0]['evidence'][0]['bounce_times_seconds'] == [0, 1, 1.8, 2.4]


def test_scans_later_subsequences_after_an_initial_failure():
    result = cluster([0, 1, 2, 2.8], heights=(10, 20, 15), speeds=(10, 20, 15))
    assert result[0]['start_time_seconds'] == 1


def test_real_flight_metrics_use_elapsed_time_and_do_not_bridge_missing_points():
    points = [point(0, 0, y=50), point(1, .1, y=40), point(2, .2, y=50),
              point(3, .3, y=44), point(4, .4, y=50)]
    heights, speeds = hybrid._flight_metrics([event(points[i]) for i in (0, 2, 4)], points)
    assert heights == [10, 6]
    assert speeds == pytest.approx([100, 60])  # opposite directions must not cancel speed
    points[1] = replace(points[1], visibility=0)
    assert hybrid._flight_metrics([event(points[i]) for i in (0, 2, 4)], points)[0][0] is None


def summary(points):
    return VisibilityRallySummary(points[0].frame, points[-1].frame, points[0].time, points[-1].time)


def run_with_candidate(points, events, fragments=(), restart=True):
    calls = []
    def candidates(values, *args, **kwargs):
        calls.append(values)
        return (summary(values),) if len(calls) == 1 or restart else ()
    with patch.object(hybrid, 'blurball_visibility_rallies', side_effect=candidates), \
         patch.object(hybrid, 'slow_transfer_runs', return_value=()), \
         patch.object(hybrid, 'dead_bounce_fragments', return_value=list(fragments)):
        result = hybrid.hybrid_motion_rallies(points, 20, CALIBRATION, motion_config=CONFIG, events=events)
    return result, calls


def test_missing_bounces_inside_motion_never_split_and_counts_use_final_interval():
    points = [point(i) for i in range(101)]
    result, calls = run_with_candidate(points, [event(points[0]), event(points[-1])])
    assert len(result.rallies) == 1
    assert result.rallies[0].bounce_count == 2
    assert len(calls) == 1


def test_zero_bounce_whole_rally_is_deleted_with_evidence():
    result, _ = run_with_candidate([point(i) for i in range(101)], [])
    assert not result.rallies
    assert result.excluded_fragments == ({'start_time_seconds': 0, 'end_time_seconds': 5.05,
                                          'evidence': [{'reason': 'zero_bounce_rally', 'bounce_count': 0}]},)


@pytest.mark.parametrize('restart,expected', [(True, 2), (False, 1)])
def test_exclusion_removes_last_bounce_and_right_side_must_restart(restart, expected):
    points = [point(i) for i in range(101)]
    fragment = {'start_time_seconds': 2, 'end_time_seconds': 3.05,
                'evidence': [{'reason': 'dead_bounce_cluster'}]}
    result, calls = run_with_candidate(points, [event(points[i]) for i in (10, 40, 60, 90)], [fragment], restart)
    assert len(result.rallies) == expected
    assert result.bounce_frames == (10, 90)
    assert result.rallies[0].end_time == 1.95
    assert calls[1][0].time == 3.05
    if restart:
        assert result.rallies[1].start_time == 3.05
        assert [r.bounce_count for r in result.rallies] == [1, 1]


def test_slow_pass_without_bounces_records_only_movement_not_held_frames():
    points = [point(i, x=x, y=0) for i, x in enumerate([0] * 5 + list(range(0, 101, 5)) + [100] * 5)]
    runs = hybrid.slow_transfer_runs(points, CALIBRATION, CONFIG)
    assert len(runs) == 1
    assert (runs[0][0].frame, runs[0][-1].frame) == (5, 25)
    result = hybrid.hybrid_motion_rallies(points, 20, CALIBRATION, motion_config=CONFIG, events=[])
    assert any(e['reason'] == 'slow_transfer' for f in result.excluded_fragments for e in f['evidence'])
    assert not result.bounce_frames


def test_slow_flight_strike_guard_is_local_and_requires_table_support():
    points = [point(i, x=i*5, y=70) for i in range(21)]
    with patch.object(hybrid, '_slow_transfer_runs', return_value=(tuple(points),)), \
         patch.object(hybrid, 'observed_strike_times', return_value=(.5,)):
        assert not hybrid.slow_transfer_runs(points, CALIBRATION, CONFIG)
        outside = [replace(p, y=-100) for p in points]
        assert hybrid.slow_transfer_runs(outside, CALIBRATION, CONFIG)
    with patch.object(hybrid, '_slow_transfer_runs', return_value=(tuple(points),)), \
         patch.object(hybrid, 'observed_strike_times', return_value=(2.0,)):
        assert hybrid.slow_transfer_runs(points, CALIBRATION, CONFIG)


def test_cross_language_provenance_fixture_matches_production():
    path = Path(__file__).resolve().parents[2] / 'tests/fixtures/hybrid-provenance.json'
    assert hybrid.hybrid_provenance() == json.loads(path.read_text(encoding='utf-8'))


def test_real_motion_candidate_is_not_split_by_a_four_second_bounce_detection_gap():
    points = [point(i, x=20 + 160 * abs((i % 16) - 8) / 8, y=70) for i in range(101)]
    result = hybrid.hybrid_motion_rallies(points, 20, CALIBRATION, motion_config=CONFIG,
                                         events=[event(points[10]), event(points[90])])
    assert len(result.rallies) == 1
    assert result.rallies[0].bounce_count == 2
    assert not result.excluded_fragments
