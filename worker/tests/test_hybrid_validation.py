import importlib.util
import json
from pathlib import Path
import subprocess
import sys
from unittest.mock import patch
from ttcut_worker.hybrid_rallies import HybridResult


SCRIPT = Path(__file__).resolve().parents[2] / 'scripts/validate-hybrid-rallies.py'
spec = importlib.util.spec_from_file_location('hybrid_validation', SCRIPT)
validation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validation)


def test_comparison_reports_split_merged_missing_and_unexpected():
    actual = {'rallies': [
        {'start_time_seconds': 1, 'end_time_seconds': 3, 'bounce_count': 1},
        {'start_time_seconds': 4, 'end_time_seconds': 8, 'bounce_count': 2},
        {'start_time_seconds': 20, 'end_time_seconds': 22, 'bounce_count': 1},
    ], 'excluded_fragments': []}
    expected = {'rallies': [
        {'start_time_seconds': 1, 'end_time_seconds': 5, 'bounce_count': 2},
        {'start_time_seconds': 6, 'end_time_seconds': 8, 'bounce_count': 1},
        {'start_time_seconds': 10, 'end_time_seconds': 12, 'bounce_count': 1},
    ]}
    rows = validation.compare(actual, expected)
    assert [r['relation'] for r in rows] == ['split_and_merged', 'merged', 'missing', 'unexpected']
    assert validation.approved_matches(actual, expected) is None


def test_approval_requires_exact_bounds_types_and_counts_not_just_totals():
    actual = {'rallies': [{'start_time_seconds': 1, 'end_time_seconds': 3, 'bounce_count': 2}],
              'excluded_fragments': [{'start_time_seconds': 4, 'end_time_seconds': 6,
                                      'evidence': [{'reason': 'slow_transfer'}]}]}
    labels = {'approved': True, 'rallies': [dict(actual['rallies'][0])],
              'excluded_fragments': [{'start_time_seconds': 4, 'end_time_seconds': 6, 'reasons': ['slow_transfer']}]}
    assert validation.approved_matches(actual, labels)
    labels['rallies'][0]['bounce_count'] = 3
    assert not validation.approved_matches(actual, labels)
    labels['rallies'][0]['bounce_count'] = 2
    labels['excluded_fragments'][0]['reasons'] = ['dead_bounce_cluster']
    assert not validation.approved_matches(actual, labels)
    labels['excluded_fragments'][0]['reasons'] = ['slow_transfer']
    labels['rallies'][0]['start_time_seconds'] = 1.1
    assert not validation.approved_matches(actual, labels)


def test_cli_keeps_unreviewed_cache_unapproved_and_writes_both_formats(tmp_path):
    cache = tmp_path / 'cache.json'
    cache.write_text(json.dumps({
        'fps': 20, 'width': 200, 'height': 100,
        'calibration': {'video_width': 200, 'video_height': 100,
                        'points': [[0, 50], [199, 50], [199, 99], [0, 99]]},
        'trajectory': [[i / 20, 0, 0, 0] for i in range(20)],
    }), encoding='utf-8')
    output = tmp_path / 'report'
    result = subprocess.run([sys.executable, str(SCRIPT), str(cache), '--output', str(output), '--check'],
                            capture_output=True, text=True)
    assert result.returncode == 1
    report = json.loads((output / 'report.json').read_text(encoding='utf-8'))
    assert report['manual_approval'] is False
    assert report['approved_baseline_matches'] is None
    assert report['actual']['missing_confidence'] is True
    assert (output / 'comparison.csv').is_file()


def test_full_and_compact_cache_rows_keep_confidence_and_exact_motion_configuration():
    payload = {
        'fps': 30, 'motion_config': {'analysis_width_pixels': 200, 'analysis_height_pixels': 100,
                                    'vertical_exchange_enabled': False},
        'calibration': {'video_width': 200, 'video_height': 100,
                        'points': [[0, 50], [199, 50], [199, 99], [0, 99]]},
        'time_source': 'original_vfr',
        'trajectory': [[1, .045, 1, 50, 60, .8],
                       {'frame': 2, 'time': .091, 'visibility': 1, 'x': 55, 'y': 62,
                        'confidence': .9, 'time_source': 'original_vfr'}],
    }
    with patch.object(validation, 'hybrid_motion_rallies', return_value=HybridResult((), (), ())) as run:
        result = validation.replay(payload)
    assert result['missing_confidence'] is False
    points = run.call_args.args[0]
    assert [p.confidence for p in points] == [.8, .9]
    assert [p.time for p in points] == [.045, .091]
    assert all(p.time_source == 'original_vfr' for p in points)
    assert run.call_args.kwargs['motion_config'].vertical_exchange_enabled is False
