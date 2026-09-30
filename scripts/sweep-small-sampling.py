"""Sweep real Small inference rates; compare continuous intervals to annotations.

Acceptance limits are fixed before viewing the sweep. No calibration fitting or
history writes. Existing 30/12 fps measured runs remain read-only references.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import html
from pathlib import Path
import subprocess
import sys
import time

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
LIMITS = {"precision_drop": .02, "recall_drop": .02, "accuracy_drop": .01,
          "start_mae_increase_sec": .2, "end_mae_increase_sec": .2}


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def save(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def coverage_function(intervals, horizon):
    known = []
    for row in intervals:
        if row["label"] not in ("FIRE", "PLAY", "OTHER"):
            continue
        start = max(0., (int(row["start_frame"]) - 1) / float(row["fps"]))
        end = min(horizon, int(row["end_frame"]) / float(row["fps"]))
        if end <= start:
            continue
        if known and start <= known[-1][1] + 1e-8:
            known[-1][1] = max(known[-1][1], end)
        else:
            known.append([start, end])
    starts, ends = np.asarray(known).T
    lengths = ends - starts
    prefix = np.r_[0., np.cumsum(lengths)]

    def coverage(t):
        t = np.asarray(t)
        indices = np.searchsorted(starts, t, side="right") - 1
        safe = np.maximum(indices, 0)
        return np.where(indices < 0, 0., prefix[safe] + np.clip(t - starts[safe], 0., lengths[safe]))
    return coverage


def match(predicted, references, coverage, threshold=.5):
    p = np.array([[r["start_sec"], r["end_sec"]] for r in predicted]).reshape(-1, 2)
    r = np.array([[r["start_sec"], r["end_sec"]] for r in references]).reshape(-1, 2)
    pd = coverage(p[:, 1]) - coverage(p[:, 0])
    rd = coverage(r[:, 1]) - coverage(r[:, 0])
    p, pd = p[pd > 0], pd[pd > 0]
    r, rd = r[rd > 0], rd[rd > 0]
    starts = np.maximum(p[:, 0, None], r[None, :, 0])
    ends = np.maximum(starts, np.minimum(p[:, 1, None], r[None, :, 1]))
    intersection = coverage(ends) - coverage(starts)
    union = pd[:, None] + rd[None, :] - intersection
    iou = np.divide(intersection, union, out=np.zeros_like(union), where=union > 0)
    adjacency = [list(np.flatnonzero(row >= threshold)[np.argsort(-row[row >= threshold])]) for row in iou]
    owner = {}

    def augment(pred, seen):
        for ref in adjacency[pred]:
            if ref in seen:
                continue
            seen.add(ref)
            if ref not in owner or augment(owner[ref], seen):
                owner[ref] = pred
                return True
        return False

    for pred in np.argsort(-iou.max(axis=1)) if len(r) else []:
        augment(int(pred), set())
    pairs = [(pred, int(ref)) for ref, pred in owner.items()]
    tp, fp, fn = len(pairs), len(p) - len(pairs), len(r) - len(pairs)
    result = {"tp": tp, "fp": fp, "fn": fn, "precision": tp / max(1, tp + fp),
              "recall": tp / max(1, tp + fn), "f1": 2 * tp / max(1, 2 * tp + fp + fn),
              "pairs": pairs}
    for index, edge in enumerate(("start", "end")):
        errors = np.array([p[a, index] - r[b, index] for a, b in pairs])
        result[edge + "_mae_sec"] = float(np.mean(abs(errors))) if len(errors) else None
        result[edge + "_p90_sec"] = float(np.quantile(abs(errors), .9)) if len(errors) else None
    return result


def metrics(recognized, intervals, references, horizon):
    from rally_detection.evaluation import classification_metrics
    classes = {"FIRE": 0, "PLAY": 1, "OTHER": 2}
    predicted_classes = {"serve": 0, "play": 1, "other": 2}
    confusion = np.zeros((3, 3))
    for truth in intervals:
        if truth["label"] not in classes:
            continue
        start = (int(truth["start_frame"]) - 1) / float(truth["fps"])
        end = min(horizon, int(truth["end_frame"]) / float(truth["fps"]))
        for phase in recognized["segments"]:
            duration = max(0., min(end, phase["end_sec"]) - max(start, phase["start_sec"]))
            confusion[classes[truth["label"]], predicted_classes[phase["label"]]] += duration
    coverage = coverage_function(intervals, horizon)
    expected = float(coverage(horizon))
    if abs(confusion.sum() - expected) > 1e-6:
        raise ValueError("Prediction does not cover the fixed reviewed timeline")
    # Source classification_metrics uses max(1, denominator). Seconds may be
    # sub-unit, so scale the confusion to microseconds before reusing the API.
    return {"phase": classification_metrics(confusion * 1e6), "confusion_seconds": confusion.tolist(),
            "reviewed_seconds": expected, "rallies_total": len(recognized["rallies"]),
            "rally_50": match(recognized["rallies"], references, coverage),
            "rally_75": match(recognized["rallies"], references, coverage, .75),
            "highlights": {str(t): sum(r["end_sec"] - r["start_sec"] > t for r in recognized["rallies"]) for t in (2.7, 4, 4.8)}}


def assess(candidate, baseline):
    c, b = candidate["rally_50"], baseline["rally_50"]
    deltas = {"precision_drop": b["precision"] - c["precision"], "recall_drop": b["recall"] - c["recall"],
              "accuracy_drop": baseline["phase"]["accuracy"] - candidate["phase"]["accuracy"],
              "start_mae_increase_sec": c["start_mae_sec"] - b["start_mae_sec"] if c["start_mae_sec"] is not None else 1e9,
              "end_mae_increase_sec": c["end_mae_sec"] - b["end_mae_sec"] if c["end_mae_sec"] is not None else 1e9}
    failures = [key for key, value in deltas.items() if value > LIMITS[key] + 1e-9]
    return {"passes": not failures, "failures": failures, "deltas": deltas}


def write_report(output, result, intervals, references):
    import statistics
    groups = {}
    for run in result["runs"]:
        groups.setdefault(run["fps"], []).append(run)
    rows, aggregate, timeline = [], [], {}
    headers = ["FPS", "实测次数", "完整耗时中位数(s)", "评分帧数", "回合数", "阶段准确率", "精确率", "召回率", "回合F1", "起点MAE(s)", "终点MAE(s)", "通过"]
    for fps, runs in sorted(groups.items(), reverse=True):
        sample = runs[0]
        score = sample["rally_50"]
        elapsed = statistics.median(r["worker_wall_seconds"] for r in runs)
        passed = all(r["acceptance"]["passes"] for r in runs)
        stable = all(r["phase"] == sample["phase"] and r["rally_50"] == sample["rally_50"] for r in runs)
        values = [fps, len(runs), f'{elapsed:.2f}', sample["sample_count"], sample["rallies_total"],
                  f'{sample["phase"]["accuracy"]:.2%}', f'{score["precision"]:.2%}', f'{score["recall"]:.2%}', f'{score["f1"]:.2%}',
                  f'{score["start_mae_sec"]:.3f}', f'{score["end_mae_sec"]:.3f}', "通过" if passed else "未通过"]
        rows.append('<tr class="' + ('pass' if passed else 'fail') + '">' + ''.join(f'<td>{html.escape(str(v))}</td>' for v in values) + '</tr>')
        aggregate.append({"fps": fps, "runs": len(runs), "median_worker_seconds": elapsed,
                          "passes_all_runs": passed, "repeat_metrics_identical": stable,
                          "accuracy": sample["phase"]["accuracy"], "rally_50": score})
        recognized = read(Path(sample["path"]) / "recognized.json")
        timeline[str(fps)] = {"phases": [[r["start_sec"], r["end_sec"], r["label"]] for r in recognized["segments"]],
                              "rallies": [[r["start_sec"], r["end_sec"], "rally"] for r in recognized["rallies"]]}
    save(output / "aggregate.json", aggregate)
    payload = {"rates": timeline,
               "human": [[(int(r["start_frame"])-1)/float(r["fps"]), int(r["end_frame"])/float(r["fps"]), r["label"]] for r in intervals],
               "reference": [[r["start_sec"], r["end_sec"], "rally"] for r in references]}
    report = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>1-193 Small 采样率扫描</title>
<style>body{font:15px/1.6 system-ui;margin:32px;color:#172437}table{border-collapse:collapse;font-size:13px}td,th{padding:8px;border:1px solid #ccd3dc;text-align:right}th{background:#f0f4f8}.fail{background:#fff0ee}.pass{background:#f0faf5}svg{width:100%;min-width:900px;background:#f7f9fb}input{width:50%}p{max-width:1100px}</style>
<h1>1-193 · Small 实际采样率扫描</h1><p>容差预先固定：相对30 fps，精确率/召回率各下降≤2个百分点，阶段准确率下降≤1个百分点，起点/终点平均误差各增加≤0.2秒。沿用原30 fps训练的v4校准参数，不在本片调参。扫描后用户选择采用6 fps；本页列出实验。</p>
<p>所有低帧率都从原视频由FFmpeg实际采样、预处理、推理；评分fps及解码fps同步下降。评价采用精确秒制区间交集，无重采样近似；仅评价共同0–507秒内的已标注部分。30/12 fps参考包含上次已完成的实测，本次复测单独保存。这是本片、当前模型、整数fps网格上的结论，不是任意视频或任意小数fps的全局下限。</p>
<table><thead><tr>HEADERS</tr></thead><tbody>ROWS</tbody></table>
<h2>与人工标注及30 fps的边界对照</h2><p>橙：发球；蓝：对打；灰：其他；绿：回合；空白：未标注。悬停查看边界。回合匹配阈值IoU≥0.5，精确率/召回率均基于一对一匹配。</p>
<label>实验采样率 <select id="rate">OPTIONS</select></label> <label>范围 <select id="span"><option>30</option><option>60</option><option>120</option><option value="508">全片</option></select> 秒</label>
<input id="pos" type="range" min="0" max="478" value="0" step="0.1"><span id="time"></span><svg id="chart" viewBox="0 0 1200 400"></svg>
<script>const data=PAYLOAD,ns='http://www.w3.org/2000/svg',chart=document.getElementById('chart'),pos=document.getElementById('pos'),span=document.getElementById('span'),rate=document.getElementById('rate');
function node(tag,attrs,text){const n=document.createElementNS(ns,tag);for(const[k,v]of Object.entries(attrs))n.setAttribute(k,v);if(text!==undefined)n.textContent=text;chart.append(n);return n}
function draw(){const width=+span.value;pos.max=Math.max(0,508-width);const start=+pos.value,end=start+width,x=t=>150+(t-start)/width*1035;chart.replaceChildren();document.getElementById('time').textContent=start.toFixed(1)+'–'+end.toFixed(1)+'s';const rows=[['人工阶段',data.human],['人工回合',data.reference],['30 fps 阶段',data.rates['30'].phases],['30 fps 回合',data.rates['30'].rallies],[rate.value+' fps 阶段',data.rates[rate.value].phases],[rate.value+' fps 回合',data.rates[rate.value].rallies]];rows.forEach(([name,items],i)=>{const y=i*60+10;node('text',{x:4,y:y+23,'font-size':13},name);node('rect',{x:150,y,width:1035,height:35,fill:'#fff',stroke:'#ccd3dc'});for(const[a,b,k]of items){if(b<=start||a>=end)continue;const n=node('rect',{x:x(Math.max(start,a)),y,width:Math.max(.5,x(Math.min(end,b))-x(Math.max(start,a))),height:35,fill:({FIRE:'#e99a30',serve:'#e99a30',PLAY:'#4385cd',play:'#4385cd',OTHER:'#aeb7c2',other:'#aeb7c2',rally:'#3eaa79'})[k]||'#eee'});const t=document.createElementNS(ns,'title');t.textContent=k+' '+a.toFixed(3)+'–'+b.toFixed(3)+'s';n.append(t)}})}pos.oninput=draw;span.onchange=draw;rate.onchange=draw;draw();</script></html>'''
    options = ''.join(f'<option value="{fps}"' + (' selected' if fps == result["lowest_passing_tested_fps"] else '') + f'>{fps} fps</option>' for fps in sorted(groups))
    report = report.replace("HEADERS", ''.join(f'<th>{v}</th>' for v in headers)).replace("ROWS", ''.join(rows))
    report = report.replace("OPTIONS", options).replace("PAYLOAD", json.dumps(payload, ensure_ascii=False).replace("</", "<\\/"))
    (output / "report.html").write_text(report, encoding="utf-8")


def evaluate(args):
    from rally_detection.evaluation import reference_rallies
    request = read(args.output / "request.json")
    horizon = math.floor(request["video_metadata"]["duration_seconds"])
    with (args.source / "data/annotations/intervals.csv").open(encoding="utf-8-sig", newline="") as stream:
        intervals = sorted([r for r in csv.DictReader(stream) if r["source_relative_path"] == args.video_name],
                           key=lambda r: int(r["start_frame"]))
    if not intervals:
        raise ValueError("No annotation intervals")
    references = reference_rallies(intervals)
    baseline_dir = args.baseline / "run-1-30fps"
    baseline = metrics(read(baseline_dir / "recognized.json"), intervals, references, horizon)
    directories = [baseline_dir]
    for name in ("run-4-30fps", "run-2-12fps", "run-3-12fps"):
        existing = args.baseline / name
        if existing.exists():
            directories.append(existing)
    directories += sorted(args.output.glob("run-*"))
    runs = []
    for directory in directories:
        if not (directory / "timings.json").exists() or not (directory / "recognized.json").exists():
            continue
        recognized = read(directory / "recognized.json")
        result = {"run": directory.name, "path": str(directory.resolve()), **read(directory / "timings.json"),
                  **metrics(recognized, intervals, references, horizon)}
        result["acceptance"] = assess(result, baseline)
        runs.append(result)
    result = {"video": request["video_path"], "source_sha256": digest(request["video_path"]),
              "annotation_sha256": digest(args.source / "data/annotations/intervals.csv"),
              "limits": LIMITS, "horizon_seconds": horizon, "reference_rallies": len(references),
              "method": "Exact continuous interval intersections, unknown time excluded; one-to-one maximum-cardinality rally matching",
              "runs": sorted(runs, key=lambda r: (-r["fps"], r["run"]))}
    passing = [r["fps"] for r in runs if r["acceptance"]["passes"]]
    result["lowest_passing_tested_fps"] = min(passing) if passing else None
    save(args.output / "sweep.json", result)
    write_report(args.output, result, intervals, references)
    for r in result["runs"]:
        m = r["rally_50"]
        print(f'{r["run"]}: {r.get("worker_wall_seconds",0):.2f}s, rounds={r["rallies_total"]}, '
              f'acc={r["phase"]["accuracy"]:.4%}, P/R/F1={m["precision"]:.4%}/{m["recall"]:.4%}/{m["f1"]:.4%}, '
              f'edges={m["start_mae_sec"]:.3f}/{m["end_mae_sec"]:.3f}s, '
              f'PASS={r["acceptance"]["passes"]} {r["acceptance"]["failures"]}', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path("E:/MobileNetV3-Large"))
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--video-name", default="1-193.mp4")
    parser.add_argument("--rates", type=int, nargs="+", default=list(range(11, 0, -1)))
    parser.add_argument("--evaluate-only", action="store_true")
    parser.add_argument("--tag", default="sweep")
    args = parser.parse_args()
    sys.path.insert(0, str(args.source))
    if not args.evaluate_only:
        args.output.mkdir(parents=True, exist_ok=True)
        request = read(args.baseline / "request.json")
        baseline_identity = read(args.baseline / "run-1-30fps/recognized.json")["source"]["source_sha256"]
        if digest(request["video_path"]) != baseline_identity:
            raise ValueError("Video changed since measured baseline")
        save(args.output / "request.json", request)
        save(args.output / "acceptance-limits.json", LIMITS)
        for rate in args.rates:
            if rate not in range(1, 13) and rate != 30:
                raise ValueError("Unsupported rate")
            directory = args.output / f"run-{args.tag}-{rate:02d}fps"
            directory.mkdir(exist_ok=False)
            started = time.perf_counter()
            subprocess.run([sys.executable, "-B", str(ROOT / "scripts/benchmark-small-sampling.py"),
                            "--child", "--fps", str(rate), "--source", str(args.source), "--output", str(directory)], check=True)
            timings = read(directory / "timings.json")
            save(directory / "timings.json", {**timings, "worker_wall_seconds": time.perf_counter() - started})
            evaluate(args)
    else:
        evaluate(args)


if __name__ == "__main__":
    main()
