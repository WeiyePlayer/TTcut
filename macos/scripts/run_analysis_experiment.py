#!/usr/bin/env python3
"""Run one isolated native benchmark and compare frame/rally output with a baseline."""
import argparse
import json
import math
import os
from pathlib import Path
import re
import subprocess
import time


def compare(reference, actual):
    before, after = reference['points'], actual['points']
    assert len(before) == len(after), 'decoded frame count changed'
    assert [(p['frame'], p['time']) for p in before] == [(p['frame'], p['time']) for p in after], 'frame identity changed'
    distances = [math.hypot(a['x']-b['x'], a['y']-b['y']) for a, b in zip(before, after) if a['visible'] and b['visible']]
    distances.sort()
    confidence = [abs(a['confidence']-b['confidence']) for a, b in zip(before, after)]
    return {
        'frames': len(after), 'baseline_visible': sum(p['visible'] for p in before),
        'visible_to_invisible': sum(a['visible'] and not b['visible'] for a, b in zip(before, after)),
        'invisible_to_visible': sum(not a['visible'] and b['visible'] for a, b in zip(before, after)),
        'coordinate_changed_frames': sum(a['visible'] and b['visible'] and (a['x'],a['y']) != (b['x'],b['y']) for a,b in zip(before,after)),
        'coordinate_max_px': max(distances, default=0),
        'coordinate_p99_px': distances[min(len(distances)-1, int(len(distances)*0.99))] if distances else 0,
        'confidence_max_abs': max(confidence, default=0),
        'bounce_frames_identical': reference['bounceFrames'] == actual['bounceFrames'],
        'bounce_frames_added': sorted(set(actual['bounceFrames'])-set(reference['bounceFrames'])),
        'bounce_frames_removed': sorted(set(reference['bounceFrames'])-set(actual['bounceFrames'])),
        'all_trajectory_fields_identical': before == after,
    }


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--request', type=Path, required=True)
    p.add_argument('--models', type=Path, required=True)
    p.add_argument('--label', required=True)
    p.add_argument('--units', choices=['gpu', 'all', 'ane'], default='gpu')
    p.add_argument('--prefetch', action='store_true')
    p.add_argument('--concurrency', type=int, choices=[0, 1, 2, 4], default=0)
    p.add_argument('--limit', type=int, default=0)
    p.add_argument('--reference', type=Path)
    args = p.parse_args()
    out = args.output.resolve()
    request = json.loads(args.request.read_text())
    request['modelsDirectory'] = str(args.models.resolve())
    assert request['video']['path'] == '/Users/weiye/Documents/1-193.mp4'
    assert request['mode'] == 'full'
    destination = out / (args.label + '.diagnostic.json')
    if destination.exists(): raise RuntimeError(f'Refusing to overwrite {destination}')
    env = dict(os.environ, TT_BENCH_RESULT=str(destination), TT_BENCH_UNITS=args.units,
               TT_BENCH_PREFETCH='1' if args.prefetch else '0', TT_BENCH_CONCURRENCY=str(args.concurrency), TT_BENCH_LIMIT=str(args.limit))
    state_tool = out/'thermal-state'
    def state():
        return json.loads(subprocess.check_output([str(state_tool)], text=True)) if state_tool.exists() else None
    before_state = state()
    started = time.monotonic()
    completed = subprocess.run(['/usr/bin/time', '-l', str(out/'package/.build/release/TTcutWorker')],
                               input=json.dumps(request)+'\n', text=True, capture_output=True, env=env, timeout=900)
    wall = time.monotonic()-started
    (out/(args.label+'.stdout.jsonl')).write_text(completed.stdout)
    (out/(args.label+'.stderr.txt')).write_text(completed.stderr)
    if completed.returncode: raise RuntimeError(completed.stdout[-2000:] + completed.stderr[-4000:])
    diagnostic = json.loads(destination.read_text())
    result = json.loads(completed.stdout.splitlines()[-1])
    assert result['type'] == 'result'
    rss = re.search(r'(\d+)\s+maximum resident set size', completed.stderr)
    summary = dict(label=args.label, units=args.units, prefetch=args.prefetch, concurrency=args.concurrency,
                   limit=args.limit, worker_seconds=diagnostic['seconds'], wall_seconds=wall,
                   max_rss_bytes=int(rss[1]) if rss else None,
                   frames=len(diagnostic['points']), rallies=result['rallies'], bounce_count=len(diagnostic['bounceFrames']))
    summary['state_before'] = before_state
    summary['state_after'] = state()
    if args.reference:
        reference = json.loads(args.reference.read_text())
        summary['comparison'] = compare(reference, diagnostic)
        reference_output = args.reference.with_name(args.reference.name.replace('.diagnostic.json', '.stdout.jsonl'))
        prior = json.loads(reference_output.read_text().splitlines()[-1])
        summary['comparison']['rallies_identical'] = prior['rallies'] == result['rallies']
        summary['comparison']['bounce_times_identical'] = prior['bounceTimes'] == result['bounceTimes']
        old_ranges = [(r['start'], r['end']) for r in prior['rallies']]
        new_ranges = [(r['start'], r['end']) for r in result['rallies']]
        summary['comparison']['rally_ranges_identical'] = old_ranges == new_ranges
        if len(old_ranges) == len(new_ranges):
            summary['comparison']['changed_rally_ranges'] = sum(a != b for a, b in zip(old_ranges, new_ranges))
            summary['comparison']['max_aligned_boundary_delta_seconds'] = max(
                (abs(a-b) for old, new in zip(old_ranges, new_ranges) for a,b in zip(old,new)), default=0)
    (out/(args.label+'.summary.json')).write_text(json.dumps(summary, indent=2)+'\n')
    print(json.dumps({**{key: value for key, value in summary.items() if key != 'rallies'},
                      'rally_count': len(summary['rallies'])}), flush=True)


if __name__ == '__main__':
    main()
