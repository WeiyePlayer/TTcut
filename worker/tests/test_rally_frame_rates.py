"""Exercise the production source-time path, including real cached detections."""
from dataclasses import replace
import gzip
import json
from pathlib import Path

import pytest

from ttcut_worker.blurball_bounce import _BounceCandidate, detect_blurball_bounce_events
from ttcut_worker.calibration import TableCalibration
from ttcut_worker.hybrid_rallies import source_time_hybrid_rallies, hybrid_provenance
from ttcut_worker.rally_timebase import observed_pauses, rally_clock_points
from ttcut_worker.types import TrajectoryPoint
from ttcut_worker.visibility_rallies import VisibilityMotionConfig


CALIBRATION = TableCalibration.from_points(1000, 500, [[0, 250], [999, 250], [999, 499], [0, 499]])
CONFIG = VisibilityMotionConfig(1000, 500)


@pytest.mark.parametrize('fps', [30, 60, 120])
def test_same_physical_bounce_uses_the_same_time_window_and_speed(fps):
    points = [TrajectoryPoint(frame, frame / fps, 1, 100 + 100 * frame / fps,
                              400 - 240 * abs(frame / fps - 1), 'blurball', 1.0)
              for frame in range(round(.7 * fps), round(1.3 * fps) + 1)]
    clock, source = rally_clock_points(points)
    events = detect_blurball_bounce_events(clock, CALIBRATION)
    assert len(events) == 1
    assert events[0].point.time == pytest.approx(1, abs=1 / fps)
    assert source[events[0].point.frame] in points
    assert events[0].before_velocity == pytest.approx((100 / 30, 240 / 30))
    assert events[0].after_velocity == pytest.approx((100 / 30, -240 / 30))


def exchange_points(fps, *, pause):
    return [TrajectoryPoint(frame, frame / fps, 1,
                            100 + 200 * (1 - abs((frame / fps % 1) * 2 - 1))
                            if not pause or frame / fps < 2 or 5 <= frame / fps < 7 else 100,
                            400, 'blurball', 1.0) for frame in range(8 * fps)]


def fixed_bounces(monkeypatch, times):
    def detect(points, *args, **kwargs):
        return [_BounceCandidate(min(points, key=lambda p: abs(p.time - t)), 10, 'test') for t in times]
    monkeypatch.setattr('ttcut_worker.hybrid_rallies.detect_blurball_bounce_events', detect)


@pytest.mark.parametrize('fps', [30, 60, 120])
def test_continuously_visible_held_ball_separates_exchanges_at_every_frame_rate(fps, monkeypatch):
    points = exchange_points(fps, pause=True)
    fixed_bounces(monkeypatch, [.5, 1.5, 5.5, 6.5])
    result = source_time_hybrid_rallies(points, CALIBRATION, motion_config=CONFIG)
    assert len(result.rallies) == 2
    assert result.rallies[0].start_time == 0
    assert result.rallies[0].end_time <= 2.3
    assert 4.7 <= result.rallies[1].start_time <= 5.1
    assert all(rally.bounce_count == 2 for rally in result.rallies)
    assert all(points[rally.start_frame].time == rally.start_time for rally in result.rallies)


@pytest.mark.parametrize('fps', [30, 60, 120])
def test_continuous_exchange_is_not_split_when_bounces_are_missing(fps, monkeypatch):
    fixed_bounces(monkeypatch, [.5, 6.5])
    result = source_time_hybrid_rallies(exchange_points(fps, pause=False), CALIBRATION, motion_config=CONFIG)
    assert len(result.rallies) == 1
    assert result.rallies[0].end_time >= 7.9


@pytest.mark.parametrize('fps', [12, 15, 24])
def test_lower_rate_sources_do_not_gain_a_longer_confirmation_delay(fps, monkeypatch):
    points = [replace(p, visibility=0) if .25 <= p.time < .4 else p
              for p in exchange_points(fps, pause=False)]
    fixed_bounces(monkeypatch, [.5, 6.5])
    result = source_time_hybrid_rallies(points, CALIBRATION, motion_config=CONFIG)
    assert len(result.rallies) == 1
    assert result.rallies[0].start_time == 0


def test_duplicate_timestamps_are_rejected_before_pause_speed_calculation():
    points = [TrajectoryPoint(i, 1, 1, i, 400) for i in range(4)]
    with pytest.raises(ValueError, match='strictly increasing'):
        source_time_hybrid_rallies(points, CALIBRATION, motion_config=CONFIG)


def test_dropouts_and_a_short_pause_do_not_become_sustained_idle_evidence():
    points = exchange_points(30, pause=False)
    for frame in range(60, 150):
        points[frame] = replace(points[frame], visibility=0)
    assert observed_pauses(points, CONFIG) == []
    points = exchange_points(30, pause=False)
    for frame in range(60, 75):
        points[frame] = replace(points[frame], x=100)
    assert observed_pauses(points, CONFIG) == []


def test_end_on_views_keep_the_existing_conservative_motion_exemption():
    assert observed_pauses(exchange_points(30, pause=True), replace(CONFIG, vertical_exchange_enabled=True)) == []


def test_sampling_keeps_missing_source_observations_and_does_not_shift_time():
    points = [TrajectoryPoint(i, 40 + i / 120, int(i != 4), i, i) for i in range(12)]
    clock, source = rally_clock_points(points)
    assert [source[p.frame] for p in clock] == [points[i] for i in (0, 4, 8, 11)]
    assert clock[1].visibility == 0
    assert [p.time for p in clock] == [points[i].time for i in (0, 4, 8, 11)]


def read_fixture(name):
    data = json.loads(gzip.decompress((Path(__file__).parent / 'fixtures' / name).read_bytes()))
    c = data['calibration']
    calibration = TableCalibration.from_points(c['video_width'], c['video_height'], c['points'])
    points = [TrajectoryPoint(f, t, v, x, y, 'blurball', conf, time_source=data['time_source'])
              for f, t, v, x, y, conf in data['trajectory']]
    return data, calibration, points, VisibilityMotionConfig(**data['motion_config'])


@pytest.mark.parametrize('factor', [1, 2, 4])
def test_reported_video_pauses_survive_denser_sampling_without_losing_adjacent_exchanges(factor):
    data, calibration, points, config = read_fixture('hybrid-source-120-converted30.json.gz')
    # Extra repeated observations isolate decision timing from model/codec changes.
    dense = [replace(p, frame=p.frame * factor + i, time=p.time + i / (30 * factor))
             for p in points for i in range(factor)]
    result = source_time_hybrid_rallies(dense, calibration, motion_config=config)
    for start, end in data['reviewed_motion_cores']:
        assert sum(r.start_time <= start and r.end_time >= end for r in result.rallies) == 1
    for time in data['reviewed_pause_times']:
        assert not any(r.start_time <= time <= r.end_time for r in result.rallies)
        assert any(f['start_time_seconds'] <= time < f['end_time_seconds'] for f in result.excluded_fragments)
    separated = [r for r in result.rallies if 40 <= r.start_time < 74]
    assert len(separated) == 4
    assert [r.bounce_count for r in separated] == [8, 22, 4, 9]
    assert all(any(p.frame == r.start_frame and p.time == r.start_time for p in dense) for r in result.rallies)


@pytest.mark.parametrize('name,start,end', [
    ('193', 376.613, 383.019), ('193', 445.515, 451.654),
    ('side', 19.1666667, 24.0666667), ('side', 260.5666667, 264.4333333),
    ('diagonal', 64.6928778, 72.8211222), ('diagonal', 715.5858111, 723.6141222),
    ('diagonal', 728.8441889, 732.9416222),
])
def test_new_timing_path_preserves_previously_reviewed_continuous_cores(name, start, end):
    _, calibration, points, config = read_fixture(f'hybrid-xml-{name}.json.gz')
    result = source_time_hybrid_rallies(points, calibration, motion_config=config)
    assert sum(r.start_time <= start + .001 and r.end_time >= end - .001 for r in result.rallies) == 1


def test_new_provenance_matches_shared_fixture():
    path = Path(__file__).resolve().parents[2] / 'tests/fixtures/hybrid-provenance-v4.json'
    assert hybrid_provenance(source_time=True) == json.loads(path.read_text(encoding='utf-8'))
