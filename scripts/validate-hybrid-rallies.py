"""Replay cached coordinates; never loads a model or reads source video frames."""
from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'worker'))
from ttcut_worker.calibration import TableCalibration
from ttcut_worker.hybrid_rallies import hybrid_motion_rallies, hybrid_provenance
from ttcut_worker.types import TrajectoryPoint
from ttcut_worker.visibility_rallies import VisibilityMotionConfig, is_end_on_table_view


def read_json(path):
    data = Path(path).read_bytes()
    return json.loads(gzip.decompress(data) if str(path).endswith('.gz') else data)


def replay(payload):
    value = payload['calibration']
    corners = value['points']
    if isinstance(corners, dict):
        corners = [corners[k] for k in ('top_left', 'top_right', 'bottom_right', 'bottom_left')]
    calibration = TableCalibration.from_points(value['video_width'], value['video_height'], corners)
    if 'motion_config' in payload:
        config = VisibilityMotionConfig(**payload['motion_config'])
    else:
        roi = payload.get('analysis_roi')
        width = roi['x1'] - roi['x0'] if roi else payload['width']
        height = roi['y1'] - roi['y0'] if roi else payload['height']
        config = VisibilityMotionConfig(width, height, vertical_exchange_enabled=is_end_on_table_view(calibration.points))
    points = []
    missing_confidence = False
    for index, row in enumerate(payload['trajectory']):
        if isinstance(row, dict):
            missing_confidence |= 'confidence' not in row
            points.append(TrajectoryPoint(**row))
            continue
        if len(row) == 4:
            row = [index, *row]
        if len(row) == 6:
            # Compact XML-regression cache: frame,time,visibility,x,y,confidence.
            points.append(TrajectoryPoint(*row[:5], source='blurball', confidence=row[5],
                                          time_source=payload.get('time_source', 'source_cfr')))
        else:
            missing_confidence |= len(row) < 7
            points.append(TrajectoryPoint(*row))
    result = hybrid_motion_rallies(points, payload['fps'], calibration, motion_config=config)
    bounce_frames = set(result.bounce_frames)
    return {
        'rally_recognition': hybrid_provenance(vertical_exchange_enabled=config.vertical_exchange_enabled),
        'rallies': [{'start_time_seconds': r.start_time, 'end_time_seconds': r.end_time, 'bounce_count': r.bounce_count}
                    for r in result.rallies],
        'excluded_fragments': list(result.excluded_fragments),
        'bounce_times_seconds': [p.time for p in points if p.frame in bounce_frames],
        'missing_confidence': missing_confidence,
    }


def compare(actual, labels):
    rows = []
    for kind, key in [('rally', 'rallies'), ('excluded', 'excluded_fragments')]:
        for index, expected in enumerate(labels.get(key, [])):
            matches = [j for j, item in enumerate(actual[key]) if min(item['end_time_seconds'], expected['end_time_seconds']) > max(item['start_time_seconds'], expected['start_time_seconds'])]
            rows.append({'kind': kind, 'expected_index': index, 'expected': expected,
                         'actual_indices': matches, 'actual': [actual[key][j] for j in matches],
                         'relation': 'missing' if not matches else 'split' if len(matches) > 1 else 'one_to_one'})
        for j, item in enumerate(actual[key]):
            refs = [r for r in rows if r['kind'] == kind and j in r['actual_indices']]
            if len(refs) > 1:
                for row in refs:
                    row['relation'] = 'split_and_merged' if len(row['actual_indices']) > 1 else 'merged'
            if not refs:
                rows.append({'kind': kind, 'expected_index': None, 'expected': None, 'actual_indices': [j], 'actual': [item], 'relation': 'unexpected'})
    return rows


def approved_matches(actual, labels):
    # Only explicitly approved labels are a baseline; do not infer approval.
    if labels.get('approved') is not True:
        return None
    tolerance = labels.get('tolerance_seconds', 0)
    for key in ('rallies', 'excluded_fragments'):
        if len(actual[key]) != len(labels[key]):
            return False
        for observed, expected in zip(actual[key], labels[key]):
            if any(abs(observed[k] - expected[k]) > tolerance for k in ('start_time_seconds', 'end_time_seconds')):
                return False
            if key == 'rallies' and observed['bounce_count'] != expected['bounce_count']:
                return False
            if key == 'excluded_fragments' and sorted({e['reason'] for e in observed['evidence']}) != sorted(expected['reasons']):
                return False
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('cache', type=Path)
    parser.add_argument('--labels', type=Path)
    parser.add_argument('--output', type=Path, required=True, help='New output directory (must not already exist)')
    parser.add_argument('--check', action='store_true', help='Require an explicitly approved matching baseline')
    args = parser.parse_args()
    actual = replay(read_json(args.cache))
    labels = read_json(args.labels) if args.labels else {}
    comparison = compare(actual, labels)
    passed = approved_matches(actual, labels)
    report = {'evidence_scope': 'cached_trajectory_only', 'cache_sha256': hashlib.sha256(args.cache.read_bytes()).hexdigest(),
              'manual_approval': labels.get('approved') is True, 'approved_baseline_matches': passed,
              'actual': actual, 'expected': labels, 'comparison': comparison}
    args.output.mkdir(parents=True, exist_ok=False)
    (args.output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    with (args.output / 'comparison.csv').open('w', newline='', encoding='utf-8-sig') as handle:
        writer = csv.DictWriter(handle, fieldnames=['kind', 'expected_index', 'relation', 'expected', 'actual_indices', 'actual'])
        writer.writeheader()
        for row in comparison:
            writer.writerow({k: json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else v for k, v in row.items()})
    print(json.dumps({'report': str(args.output / 'report.json'), 'rallies': len(actual['rallies']),
                      'excluded_fragments': len(actual['excluded_fragments']), 'approved_baseline_matches': passed}))
    return 1 if args.check and passed is not True else 0


if __name__ == '__main__':
    raise SystemExit(main())
