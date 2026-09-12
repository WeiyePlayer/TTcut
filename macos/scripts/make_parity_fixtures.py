#!/usr/bin/env python3
"""Generate deterministic domain fixtures from the unchanged Windows Python code."""
import json, random, sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/"worker"))
from ttcut_worker.blurball_bounce import detect_blurball_bounce_frames
from ttcut_worker.calibration import TableCalibration
from ttcut_worker.types import TrajectoryPoint
from ttcut_worker.roi import build_analysis_roi, model_dimensions

random.seed(7301)
corners=[[120,120],[540,140],[590,320],[80,300]]
calibration=TableCalibration.from_points(640,360,corners)
cases=[]
for case in range(60):
    points=[]; x=200; y=220; vx=5; vy=4
    for i in range(220):
        if i%17==0: vy=-vy
        if i%47==0: vx=-vx
        x=max(5,min(635,x+vx)); y=max(5,min(355,y+vy))
        visible=case==0 or random.random() > (case%5)*0.06
        points.append(TrajectoryPoint(i,i/30+((i%3)*0.001 if case%2 else 0),int(visible),x if visible else 0,y if visible else 0,"blurball" if visible else "missing",float(10+case%20) if visible else 0))
    frames=detect_blurball_bounce_frames(points,calibration)
    cases.append(dict(name=f"trajectory-{case}",points=[dict(frame=p.frame,time=p.time,x=p.x,y=p.y,confidence=p.confidence,visible=bool(p.visibility)) for p in points],expected=list(frames)))
roi=build_analysis_roi(calibration); mw,mh=model_dimensions(roi,640,360)
doc=dict(calibration=dict(width=640,height=360,points=[dict(x=x,y=y) for x,y in corners]),roi=dict(x=roi.x0,y=roi.y0,width=roi.width,height=roi.height,modelWidth=mw,modelHeight=mh),cases=cases)
output=ROOT/"macos/Tests/Core/Fixtures/python-parity.json"
output.write_text(json.dumps(doc,separators=(",",":")))
print(f"{len(cases)} Python reference fixtures written; {sum(len(x['expected']) for x in cases)} expected bounce detections")
