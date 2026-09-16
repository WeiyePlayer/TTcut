#!/usr/bin/env python3
"""Replay cached threshold trajectories through the current TrackNet rally policy."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'worker'))
from ttcut_worker.calibration import TableCalibration
from ttcut_worker.tracknet_predictor import TRACKNET_CONFIDENCE_THRESHOLD
from ttcut_worker.tracknet_rallies import tracknet_visibility_rallies
from ttcut_worker.types import TrajectoryPoint
from ttcut_worker.visibility_rallies import VisibilityMotionConfig, is_end_on_table_view


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('inputs', type=Path, nargs='+', help='Full trajectory caches from benchmark-tracknet-thresholds.py')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location('benchmark', ROOT / 'scripts/benchmark-tracknet-rallies.py')
    benchmark = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(benchmark)
    results = []
    for path in args.inputs:
        source = json.loads(path.read_text())
        cached = source['thresholds'][str(TRACKNET_CONFIDENCE_THRESHOLD)]
        roi = source['inputs']['roi']
        c = source['inputs']['calibration']
        calibration = TableCalibration.from_points(c['video_width'], c['video_height'], c['points'])
        rallies = tracknet_visibility_rallies(
            [TrajectoryPoint(**point) for point in cached['trajectory']], source['video']['fps'], calibration,
            motion_config=VisibilityMotionConfig(roi['x1'] - roi['x0'], roi['y1'] - roi['y0'],
                                                is_end_on_table_view(calibration.points)),
        )
        intervals = [(r.start_time, r.end_time) for r in rallies]
        metrics = {str(t): benchmark.matching_summary(intervals, source['target_rallies'], minimum_iou=t)
                   for t in (0.3, 0.5)}
        results.append(dict(video=source['inputs']['video'], cache_sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
                            rallies=[r.__dict__ for r in rallies], metrics=metrics))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(results, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    main()
