"""Four explicit v2 user corrections; every other raw boundary stays exact."""
import gzip
import json
from pathlib import Path

import pytest

from ttcut_worker.calibration import TableCalibration
from ttcut_worker.hybrid_rallies import hybrid_motion_rallies
from ttcut_worker.types import TrajectoryPoint
from ttcut_worker.visibility_rallies import VisibilityMotionConfig


@pytest.mark.parametrize('name,changed,count,expected', [
    ('diagonal', {52, 53, 69, 70}, 98,
     [(630.239188888889, 634.5031888888889), (826.8495666666668, 834.3115666666667)]),
    ('maharu', {32}, 44, [(214.85, 218.63333333333333), (266.21666666666664, 269.2)]),
])
def test_only_explicit_user_corrections_change_v2_boundaries(name, changed, count, expected):
    path = Path(__file__).parent / 'fixtures' / f'hybrid-v2-{name}.json.gz'
    data = json.loads(gzip.decompress(path.read_bytes()))
    c = data['calibration']
    calibration = TableCalibration.from_points(c['video_width'], c['video_height'], c['points'])
    points = [TrajectoryPoint(frame, time, visible, x, y, 'blurball', confidence,
                              time_source=data['time_source'])
              for frame, time, visible, x, y, confidence in data['trajectory']]
    result = hybrid_motion_rallies(points, data['fps'], calibration,
                                   motion_config=VisibilityMotionConfig(**data['motion_config']))
    bounds = [(r.start_time, r.end_time) for r in result.rallies]
    assert len(bounds) == count
    for old in data['baseline_rallies']:
        if old['index'] not in changed:
            assert (old['start_time_seconds'], old['end_time_seconds']) in bounds
    for span in expected:
        assert span in bounds
    assert len(bounds) == len(data['baseline_rallies']) - len(changed) + len(expected)
