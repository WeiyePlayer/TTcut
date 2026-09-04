#!/usr/bin/env python3
"""Launch a relocated Release app and exercise its bundled decoder/Core ML worker."""
import json, os, subprocess, sys, time, uuid
from pathlib import Path

def main():
    app, work = map(lambda value: Path(value).resolve(), sys.argv[1:3])
    work.mkdir(parents=True, exist_ok=True)
    env = {key: value for key, value in os.environ.items() if not key.startswith(("DYLD_", "PYTHON", "TTCUT_"))}
    env["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin"
    helpers = app / "Contents/Helpers"
    def run(*args, input=None):
        return subprocess.run(list(map(str,args)), input=input, text=True, capture_output=True, env=env, check=True)
    source = work / "standalone.mp4"
    run(helpers / "ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=8:duration=1", "-c:v", "libx264", "-preset", "ultrafast", source)
    video = dict(path=str(source), width=640, height=360, duration=1, fps=8, nominalFPS=8,
        frameRate="8/1", frameCount=8, variableFrameRate=False, videoCodec="h264", profile="", pixelFormat="yuv420p",
        bitDepth=8, chroma="420", videoTimeBase="1/16384", videoStart=0, videoDuration=1, audioChannels=0,
        audioSampleRate=48000, audioTimeBase="1/48000", audioStart=0, audioBitrate=192000, bitrate=8000000,
        sar="1:1", rotation=0, hdr="sdr", keyframes=[], audioBoundaries=[])
    calibration = dict(width=640,height=360,points=[dict(x=x,y=y) for x,y in [(100,120),(540,120),(590,320),(50,320)]])
    checks = []
    for operation in ["analyze", "calibrate"]:
        task = str(uuid.uuid4())
        request = dict(schemaVersion=1,taskID=task,operation=operation,video=video,calibration=calibration,mode="full",
            confidence=.7,stage1Confidence=.3,stage2Confidence=.7,modelsDirectory=str(app / "Contents/Resources/Models"))
        result = subprocess.run([str(helpers / "TTcutWorker")], input=json.dumps(request)+"\n", text=True,
            capture_output=True, env=env, timeout=90)
        events = [json.loads(line) for line in result.stdout.splitlines()]
        assert events and all(e["taskID"] == task for e in events),result.stderr
        terminals = [e for e in events if e["type"] in ["result", "error"]]
        assert len(terminals) == 1, events
        end = terminals[0]
        if operation == "analyze": assert result.returncode == 0 and end["type"] == "result", end
        else:
            assert any(e.get("stage") == "table_inference" for e in events), events
            assert end["type"] == "result" or end.get("error",{}).get("code") == "AUTO_CALIBRATION_FAILED", end
        checks.append(dict(operation=operation,terminal=end["type"],passed=True))
    with (work / "launch.log").open("w") as log:
        process = subprocess.Popen([str(app / "Contents/MacOS/TTcut")], env=env, stdout=log, stderr=subprocess.STDOUT)
        time.sleep(3)
        assert process.poll() is None,"Release app exited during standalone launch"
        process.terminate()
        try: process.wait(timeout=10)
        except subprocess.TimeoutExpired: process.kill(); process.wait()
    (work / "standalone.json").write_text(json.dumps(dict(passed=True,restricted_path=env["PATH"],app_launch=True,checks=checks),indent=2)+"\n")
    print("Standalone Release app launch, bundled encoding and both Core ML model paths passed")

if __name__ == "__main__": main()
