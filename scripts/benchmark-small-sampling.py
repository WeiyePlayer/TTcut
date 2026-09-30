"""Local paired 30/12 fps benchmark against source annotations, without history writes.

Run using the external project's Python. Outputs include raw scores, recognition,
TTcut results, progress, identities and metrics. No parameters are fit on this video.
"""
from __future__ import annotations

import argparse
import csv
import ctypes
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "worker"))
from ttcut_worker import mobilenet_small as bridge


def save(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")


def peak_working_set():
    class Counters(ctypes.Structure):
        _fields_ = [("cb", ctypes.c_ulong), ("PageFaultCount", ctypes.c_ulong)] + [
            (name, ctypes.c_size_t) for name in ("PeakWorkingSetSize", "WorkingSetSize", "QuotaPeakPagedPoolUsage",
                                                "QuotaPagedPoolUsage", "QuotaPeakNonPagedPoolUsage", "QuotaNonPagedPoolUsage",
                                                "PagefileUsage", "PeakPagefileUsage")]
    counters = Counters()
    counters.cb = ctypes.sizeof(counters)
    get_process = ctypes.windll.kernel32.GetCurrentProcess
    get_process.restype = ctypes.c_void_p
    read = ctypes.windll.psapi.GetProcessMemoryInfo
    read.argtypes = [ctypes.c_void_p, ctypes.POINTER(Counters), ctypes.c_ulong]
    if not read(get_process(), ctypes.byref(counters), counters.cb):
        raise ctypes.WinError()
    return counters.PeakWorkingSetSize


def child(args):
    directory = args.output
    request = json.loads((directory.parent / "request.json").read_text(encoding="utf-8"))
    request["sampling_fps"] = args.fps
    events, bucket = [], -1

    def progress(stage, current, total):
        nonlocal bucket
        events.append({"stage": stage, "current": current, "total": total, "elapsed_seconds": time.perf_counter() - started})
        if stage == "analysis" and current * 10 // max(1, total) > bucket:
            bucket = current * 10 // max(1, total)
            print(f"{directory.name}: {bucket * 10}% ({current}/{total})", flush=True)

    def observer(sequence, recognized, timings):
        sequence.save(directory / "scores.npz")
        save(directory / "recognized.json", recognized)
        save(directory / "timings.json", {**timings, "process_cpu_seconds": time.process_time() - cpu_started,
             "peak_worker_working_set_bytes": peak_working_set(), "fps": args.fps,
             "sample_count": len(sequence.values), "device": result_device(sequence),
             "gpu": __import__("torch").cuda.get_device_name(0) if __import__("torch").cuda.is_available() else None})

    started, cpu_started = time.perf_counter(), time.process_time()
    result = bridge.analyze(bridge.validate_request(request), progress, observer=observer)
    save(directory / "result.json", result)
    save(directory / "progress.json", events)


def result_device(sequence):
    import torch
    return "cuda" if torch.cuda.is_available() else "cpu"


def write_report(output, summary, timeline):
    import statistics
    import html
    rows, aggregate = [], {}
    for fps in (30, 12):
        runs = [r for r in summary["runs"] if r["fps"] == fps]
        first = runs[0]
        median = lambda key: statistics.median(r[key] for r in runs)
        aggregate[str(fps)] = {key: median(key) for key in (
            "worker_wall_seconds", "scoring_seconds", "inference_seconds", "decoding_seconds",
            "peak_worker_working_set_bytes", "cuda_peak_allocated_bytes")}
        match = first["rallies"]["at_iou"]["0.5"]
        values = [f"{fps} fps", first["sample_count"], f'{median("worker_wall_seconds"):.2f} s',
                  f'{median("scoring_seconds"):.2f} s', f'{median("inference_seconds"):.2f} s',
                  first["rallies_total"], f'{first["phase"]["accuracy"]:.2%}', f'{first["phase"]["active_iou"]:.2%}',
                  f'{match["precision"]:.2%}', f'{match["recall"]:.2%}', f'{match["f1"]:.2%}',
                  f'{match["start_mae_sec"]:.3f} s', f'{match["end_mae_sec"]:.3f} s']
        rows.append('<tr>' + ''.join(f'<td>{html.escape(str(v))}</td>' for v in values) + '</tr>')
    aggregate["wall_speedup"] = aggregate["30"]["worker_wall_seconds"] / aggregate["12"]["worker_wall_seconds"]
    save(output / "aggregate.json", aggregate)
    selected = {"人工标注": [[float(r["start_sec"]), float(r["end_sec"]), r["label"]] for r in timeline["human"]],
                "人工回合": [[r["start_sec"], r["end_sec"], "rally"] for r in timeline["reference_rallies"]]}
    for name in ("run-1-30fps", "run-2-12fps"):
        selected[name + " 阶段"] = [[r["start_sec"], r["end_sec"], r["label"]] for r in timeline[name]["segments"]]
        selected[name + " 回合"] = [[r["start_sec"], r["end_sec"], "rally"] for r in timeline[name]["rallies"]]
    payload = json.dumps(selected, ensure_ascii=False).replace("</", "<\\/")
    report = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>1-193 · Small 30 / 12 fps 对照</title>
<style>body{font:15px/1.6 system-ui;margin:32px;color:#172437}table{border-collapse:collapse;font-size:13px}td,th{padding:8px;border:1px solid #ccd3dc;text-align:right}th{background:#f0f4f8}svg{width:100%;min-width:900px;background:#f7f9fb}input{width:60%}p{max-width:1100px}</style>
<h1>1-193 · Small 30 / 12 fps 实测</h1><p>同一视频、模型、GPU。四次独立进程，顺序 30→12→12→30；速度取两次中位数。整段实际采样和推理，无历史写入，无测试视频调参。12 fps 沿用 30 fps 训练的 v4 校准系数，未重新拟合。</p>
<p>指标在共同 60 Hz 时间轴上与人工标注比较；未标注区间不计入准确率。回合匹配使用来源项目的一对一 IoU≥0.5 定义。这是单视频结果，且 Small 曾见过来源项目现有视频，不能作为新场地泛化准确率。</p>
<table><thead><tr>HEADERS</tr></thead><tbody>ROWS</tbody></table>
<p>采样耗时包含 FFmpeg 解码、画面传输、预处理及推理；推理耗时包含张量上传和结果取回。完整 worker 耗时还包含 Python/模型启动、校验与结果写出。明细见同目录 comparison.json、aggregate.json 及各 run 目录。</p>
<h2>标注与结果时间轴</h2><p>橙：发球；蓝：对打；灰：其他；绿：回合；空白：未标注。悬停查看秒制边界。</p>
<label>范围 <select id="span"><option>30</option><option>60</option><option>120</option><option value="508">全片</option></select> 秒</label>
<input id="pos" type="range" min="0" max="478" value="0" step="0.1"><span id="time"></span><svg id="chart" viewBox="0 0 1200 400"></svg>
<script>const data=PAYLOAD,ns='http://www.w3.org/2000/svg',chart=document.getElementById('chart'),pos=document.getElementById('pos'),span=document.getElementById('span');
function node(tag,attrs,text){const n=document.createElementNS(ns,tag);for(const[k,v]of Object.entries(attrs))n.setAttribute(k,v);if(text!==undefined)n.textContent=text;chart.append(n);return n}
function draw(){const width=+span.value;pos.max=Math.max(0,508-width);const start=+pos.value,end=start+width,x=t=>185+(t-start)/width*1000;chart.replaceChildren();document.getElementById('time').textContent=start.toFixed(1)+'–'+end.toFixed(1)+'s';Object.entries(data).forEach(([name,items],i)=>{const y=i*60+10;node('text',{x:4,y:y+23,'font-size':13},name);node('rect',{x:185,y,width:1000,height:35,fill:'#fff',stroke:'#ccd3dc'});for(const[a,b,k]of items){if(b<=start||a>=end)continue;const n=node('rect',{x:x(Math.max(start,a)),y,width:Math.max(.5,x(Math.min(end,b))-x(Math.max(start,a))),height:35,fill:({FIRE:'#e99a30',serve:'#e99a30',PLAY:'#4385cd',play:'#4385cd',OTHER:'#aeb7c2',other:'#aeb7c2',rally:'#3eaa79'})[k]||'#eee'});const t=document.createElementNS(ns,'title');t.textContent=k+' '+a.toFixed(3)+'–'+b.toFixed(3)+'s';n.append(t)}})}pos.oninput=draw;span.onchange=draw;draw();</script></html>'''
    headers = ["采样", "评分帧数", "完整 worker", "采样与推理", "其中推理", "回合数", "阶段准确率", "活动 IoU", "回合精确率", "回合召回率", "回合 F1", "起点 MAE", "终点 MAE"]
    (output / "report.html").write_text(report.replace("HEADERS", ''.join(f'<th>{v}</th>' for v in headers))
                                       .replace("ROWS", ''.join(rows)).replace("PAYLOAD", payload), encoding="utf-8")


def evaluate(output, source, record):
    import numpy as np
    from rally_detection.evaluation import LABEL_MAP, reference_rallies, match_intervals, summarize_matches, classification_metrics
    from rally_detection.scores import CLASSES
    with (source / "data/annotations/intervals.csv").open(encoding="utf-8-sig", newline="") as stream:
        intervals = sorted([r for r in csv.DictReader(stream) if r["source_relative_path"] == "1-193.mp4"],
                           key=lambda r: int(r["start_frame"]))
    if not intervals:
        raise ValueError("No reference intervals")
    # Common exact grid for 30 and 12 Hz; no nearest-neighbor truth re-labeling.
    fps = 60
    n = int(np.ceil(record["analysis"]["video"]["duration_seconds"] * fps))
    truth = np.full(n, -1, dtype=np.int8)
    for row in intervals:
        start = round((int(row["start_frame"]) - 1) / float(row["fps"]) * fps)
        end = round(int(row["end_frame"]) / float(row["fps"]) * fps)
        if np.any(truth[start:end] != -1):
            raise ValueError("Overlapping annotations")
        truth[start:end] = LABEL_MAP.get(row["label"], -1)
    annotated = truth >= 0
    # Rate conversion may leave different sub-frame tails. Use the same covered
    # interval for both methods, and report excluded annotated tail explicitly.
    recognized_runs = {d.name: json.loads((d / "recognized.json").read_text(encoding="utf-8"))
                       for d in sorted(output.glob("run-*"))}
    common_end = min(r["frame_count"] / r["fps"] for r in recognized_runs.values())
    known = annotated & (np.arange(n) < round(common_end * fps))
    refs = reference_rallies(intervals)
    runs = []
    for directory in sorted(output.glob("run-*")):
        recognized = recognized_runs[directory.name]
        labels = np.full(n, -1, dtype=np.int8)
        for p in recognized["segments"]:
            labels[round(p["start_sec"] * fps):round(p["end_sec"] * fps)] = CLASSES.index(p["label"])
        covered = known & (labels >= 0)
        confusion = np.bincount(truth[covered] * 3 + labels[covered], minlength=9).reshape(3, 3)
        matched = match_intervals(recognized["rallies"], refs, known, fps)
        run = {"run": directory.name, **json.loads((directory / "timings.json").read_text()),
               "rallies_total": len(recognized["rallies"]), "phase": classification_metrics(confusion),
               "confusion": confusion.tolist(), "rallies": summarize_matches([matched]),
               "annotated_seconds_without_prediction": float(np.sum(known & (labels < 0)) / fps),
               "highlights": {str(t): sum(r["duration_sec"] > t for r in recognized["rallies"]) for t in (2.7, 4, 4.8)}}
        save(directory / "evaluation.json", {**run, "matching_detail": matched})
        runs.append(run)
    summary = {"source_video": record["source"]["path"], "source_sha256": bridge.digest(Path(record["source"]["path"])),
               "annotation_sha256": bridge.digest(source / "data/annotations/intervals.csv"),
               "checkpoint_sha256": bridge.CHECKPOINT_SHA256, "base_config_sha256": bridge.CONFIG_SHA256,
               "annotation_intervals": len(intervals), "reviewed_seconds": float(known.sum() / fps),
               "annotation_total_reviewed_seconds": float(annotated.sum() / fps),
               "annotated_tail_excluded_seconds": float((annotated & ~known).sum() / fps),
               "evaluation_common_end_seconds": common_end,
               "unreviewed_seconds": float((~annotated).sum() / fps), "reference_rallies": len(refs),
               "evaluation_fps": fps, "split": "test (Small image model has already seen existing videos)",
               "calibration": "Frozen 30 Hz V4 coefficients transferred without fitting on this test video",
               "reference_rule": "Source reference_rallies: pair FIRE->PLAY across unlabelled gaps <=1.5s; unknown time excluded",
               "runs": runs}
    save(output / "comparison.json", summary)
    timeline = {"human": intervals, "reference_rallies": refs,
         **{d.name: json.loads((d / "recognized.json").read_text(encoding="utf-8")) for d in sorted(output.glob("run-*"))}}
    save(output / "timeline.json", timeline)
    write_report(output, summary, timeline)
    print(json.dumps(summary, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path("E:/MobileNetV3-Large"))
    parser.add_argument("--history", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--child", action="store_true")
    parser.add_argument("--fps", type=int, choices=bridge.SUPPORTED_SAMPLING_FPS)
    parser.add_argument("--evaluate-only", action="store_true")
    args = parser.parse_args()
    os.environ["TTCUT_MOBILENET_ROOT"] = str(args.source)
    os.environ["PATH"] = str(ROOT / ".runtime/windows/ffmpeg") + os.pathsep + os.environ["PATH"]
    sys.path.insert(0, str(args.source))
    if args.child:
        child(args)
        return
    record = json.loads(args.history.read_text(encoding="utf-8"))
    receipt = json.loads((args.source / "huji_student/data/v1/receipts/941f9689f7932a2d.json").read_text())
    if bridge.digest(Path(record["source"]["path"])) != receipt["source_sha256"]:
        raise ValueError("History video differs from annotated source identity")
    if not args.evaluate_only:
        args.output.mkdir(parents=True, exist_ok=False)
        save(args.output / "request.json", {"schema_version": 6, "task_id": str(uuid.uuid4()),
             "video_path": record["source"]["path"], "video_metadata": record["analysis"]["video"], "device": "auto"})
        # Reverse the order on repeat; each run gets a fresh Python/model process.
        for index, fps in enumerate((30, 12, 12, 30), 1):
            directory = args.output / f"run-{index}-{fps}fps"
            directory.mkdir()
            started = time.perf_counter()
            subprocess.run([sys.executable, "-B", __file__, "--child", "--fps", str(fps),
                            "--source", str(args.source), "--output", str(directory)], check=True)
            timings = json.loads((directory / "timings.json").read_text())
            save(directory / "timings.json", {**timings, "worker_wall_seconds": time.perf_counter() - started})
    evaluate(args.output, args.source, record)


if __name__ == "__main__":
    main()
