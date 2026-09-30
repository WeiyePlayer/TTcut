"""Parameterized version of the source student's full-frame video preprocessing.

FFmpeg drops frames before rawvideo transfer, resizing, JPEG and inference. The
spatial/JPEG/PIL operations match rally_detection.score.video_arrays exactly.
"""
from __future__ import annotations

import io
import json
from pathlib import Path
import subprocess
import tempfile


SUPPORTED_SAMPLING_FPS = (*range(1, 13), 30)


def video_arrays(video: Path, fps: int, *, decode_threads: int = 1):
    if type(fps) is not int or fps not in SUPPORTED_SAMPLING_FPS:
        raise ValueError("Small sampling fps must be an integer from 1 to 12, or 30")
    if type(decode_threads) is not int or not 1 <= decode_threads <= 16:
        raise ValueError("decode_threads must be an integer from 1 to 16")
    import cv2
    import numpy as np
    from PIL import Image
    from rally_detection.score import image_array
    from huji_student.common import STUDENT_HEIGHT

    probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                            "-show_entries", "stream=width,height", "-of", "json", str(video)],
                           check=True, capture_output=True, text=True)
    info = json.loads(probe.stdout)["streams"][0]
    width, height = int(info["width"]), int(info["height"])
    target_width = max(1, round(width * STUDENT_HEIGHT / height))
    command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-xerror", "-nostdin",
               "-noautorotate", "-threads", str(decode_threads), "-filter_threads", "1", "-i", str(video),
               "-map", "0:v:0", "-vf", f"setpts=PTS-STARTPTS,fps={fps}", "-fps_mode", "passthrough",
               "-an", "-sn", "-dn", "-f", "rawvideo", "-pix_fmt", "bgr24", "pipe:1"]
    with tempfile.TemporaryFile() as errors:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=errors)
        try:
            size = width * height * 3
            while True:
                parts, remaining = [], size
                while remaining:
                    part = process.stdout.read(remaining)
                    if not part:
                        break
                    parts.append(part)
                    remaining -= len(part)
                if not parts:
                    break
                if remaining:
                    raise ValueError("Truncated decoded video frame")
                frame = np.frombuffer(b"".join(parts), dtype=np.uint8).reshape(height, width, 3)
                resized = cv2.resize(frame, (target_width, STUDENT_HEIGHT), interpolation=cv2.INTER_AREA)
                ok, encoded = cv2.imencode(".jpg", resized)
                if not ok:
                    raise RuntimeError("Student JPEG encoding failed")
                with Image.open(io.BytesIO(encoded.tobytes())) as image:
                    yield image_array(image)
            if process.wait() != 0:
                errors.seek(0)
                raise RuntimeError(errors.read().decode(errors="replace"))
        finally:
            process.stdout.close()
            if process.poll() is None:
                process.kill()
            process.wait()
