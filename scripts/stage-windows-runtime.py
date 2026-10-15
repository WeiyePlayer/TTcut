from __future__ import annotations

import hashlib
import json
import os
import shutil
import struct
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DESTINATION = ROOT / ".runtime" / "windows"
DEFAULT_PYTHON_SOURCE = (
    ROOT / ".baseline" / "runtime-build" / "ttcut-analysis-3.12.13-2.12.1-cpu"
)
DEFAULT_FFMPEG_SOURCE = (
    ROOT
    / ".baseline"
    / "x264-plan-inspection"
    / "ffmpeg-N-125716-g1b1f602699-win64-gpl"
    / "bin"
)
RUNTIME_ID = "python-3.12.13-ort-dml-1.24.3-r1"
VC_RUNTIME_FILES = ("msvcp140.dll", "msvcp140_1.dll", "vcruntime140.dll", "vcruntime140_1.dll")


def resolve_vc_runtime() -> Path:
    configured = os.environ.get("TTCUT_VC_REDIST_SOURCE")
    if configured:
        return Path(configured)
    vswhere = Path(os.environ.get("ProgramFiles(x86)", "C:/Program Files (x86)")) / "Microsoft Visual Studio/Installer/vswhere.exe"
    if vswhere.is_file():
        result = subprocess.run([
            str(vswhere), "-latest", "-products", "*", "-find",
            "VC/Redist/MSVC/**/x64/Microsoft.VC*.CRT/msvcp140.dll",
        ], check=True, capture_output=True, text=True, encoding="utf-8")
        candidates = [Path(line).parent for line in result.stdout.splitlines() if line.strip()]
        # Use the desktop x64 redistributable, never the OneCore/debug libraries.
        candidates = [candidate for candidate in candidates if "onecore" not in [part.lower() for part in candidate.parts]]
        if candidates:
            return max(candidates, key=lambda candidate: tuple(int(part) for part in candidate.parent.parent.name.split(".")))
    raise RuntimeError("Set TTCUT_VC_REDIST_SOURCE to the Visual C++ x64 Microsoft.VC*.CRT redistributable directory.")


def stage_vc_runtime(source: Path, destination: Path) -> dict[str, str]:
    # Python ships vcruntime, but ONNX Runtime also imports msvcp140 and msvcp140_1.
    # A smoke test on a developer machine can silently load these from System32.
    missing = [name for name in VC_RUNTIME_FILES if not (source / name).is_file()]
    if missing:
        raise RuntimeError(f"Incomplete Visual C++ redistributable at {source}: {', '.join(missing)}")
    files = sorted(source.glob("*.dll"))
    for file in files:
        data = file.read_bytes()
        pe_offset = struct.unpack_from("<I", data, 0x3C)[0]
        if data[pe_offset:pe_offset + 4] != b"PE\0\0" or struct.unpack_from("<H", data, pe_offset + 4)[0] != 0x8664:
            raise RuntimeError(f"Visual C++ redistributable must be x64: {file}")
    destination.mkdir(parents=True, exist_ok=True)
    for file in files:
        shutil.copy2(file, destination / file.name)
    return {f"python/{file.name}": sha256(destination / file.name) for file in files}


def sha256(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def copy_runtime(source: Path, destination: Path) -> None:
    if not (source / "python.exe").is_file():
        raise RuntimeError(f"Python runtime source is invalid: {source}")
    shutil.copytree(source, destination, dirs_exist_ok=True, ignore=shutil.ignore_patterns(
        "site-packages", "torch", "torch-*", "torchgen", "functorch", "triton", "*.pyc", "__pycache__",
    ))
    site_packages = destination / "Lib" / "site-packages"
    site_packages.mkdir(parents=True, exist_ok=True)
    subprocess.run([
        str(source / "python.exe"), "-I", "-m", "pip", "install",
        "--disable-pip-version-check", "--no-compile", "--upgrade",
        "--target", str(site_packages),
        "numpy==2.5.1", "opencv-python-headless==4.13.0.92",
        "onnxruntime-directml==1.24.3",
    ], check=True)
    # pip wheels contain conversion/training helpers and type stubs that are not
    # part of production inference.  Remove them explicitly so the shipped
    # runtime cannot be mistaken for a Torch/CUDA-capable environment.
    for relative in (
        "Scripts",
        "Lib/site-packages/cv2/cuda",
        "Lib/site-packages/onnxruntime/tools",
        "Lib/site-packages/onnxruntime/transformers",
        "Lib/site-packages/sympy/printing/tests",
    ):
        candidate = destination / relative
        if candidate.exists():
            shutil.rmtree(candidate)
    pytorch_printer = destination / "Lib" / "site-packages" / "sympy" / "printing" / "pytorch.py"
    if pytorch_printer.exists():
        pytorch_printer.unlink()


def main() -> int:
    python_source = Path(os.environ.get("TTCUT_ANALYSIS_RUNTIME_SOURCE", DEFAULT_PYTHON_SOURCE))
    ffmpeg_source = Path(os.environ.get("TTCUT_X264_BIN_SOURCE", DEFAULT_FFMPEG_SOURCE))
    vc_runtime_source = resolve_vc_runtime()
    if not all((ffmpeg_source / name).is_file() for name in ("ffmpeg.exe", "ffprobe.exe")):
        raise RuntimeError(f"x264 FFmpeg source is invalid: {ffmpeg_source}")
    if DESTINATION.exists():
        shutil.rmtree(DESTINATION)
    python_destination = DESTINATION / "python"
    media_destination = DESTINATION / "ffmpeg"
    copy_runtime(python_source, python_destination)
    vc_runtime_hashes = stage_vc_runtime(vc_runtime_source, python_destination)
    media_destination.mkdir(parents=True)
    for name in ("ffmpeg.exe", "ffprobe.exe"):
        shutil.copy2(ffmpeg_source / name, media_destination / name)

    probe = subprocess.run([
        str(python_destination / "python.exe"), "-I", "-S", "-X", "utf8", "-c",
        "import os,sys;"
        "root=os.path.dirname(os.path.abspath(sys.executable));"
        "sys.path[:]=[os.path.join(root,'python%d%d.zip'%sys.version_info[:2]),root,"
        "os.path.join(root,'DLLs'),os.path.join(root,'Lib'),os.path.join(root,'Lib','site-packages')];"
        "import json,cv2,numpy,onnxruntime as ort;"
        "module_paths={name:os.path.realpath(module.__file__) for name,module in "
        "[('numpy',numpy),('opencv',cv2),('onnxruntime',ort)]};"
        "site_root=os.path.normcase(os.path.join(os.path.realpath(root),'Lib','site-packages'));"
        "print(json.dumps({'numpy':numpy.__version__,'opencv':cv2.__version__,"
        "'onnxruntime':ort.__version__,'providers':ort.get_available_providers(),"
        "'module_paths':module_paths,'dependency_paths_valid':"
        "all(os.path.normcase(file).startswith(site_root+os.sep) for file in module_paths.values())}))",
    ], check=True, capture_output=True, text=True)
    runtime = json.loads(probe.stdout.strip().splitlines()[-1])
    if runtime["dependency_paths_valid"] is not True:
        raise RuntimeError(f"Bundled Python imported an external dependency: {runtime}")
    if runtime["numpy"] != "2.5.1" or runtime["opencv"] != "4.13.0":
        raise RuntimeError(f"Bundled Python dependency mismatch: {runtime}")
    if runtime["onnxruntime"] != "1.24.3" or "CPUExecutionProvider" not in runtime["providers"]:
        raise RuntimeError(f"Bundled ONNX Runtime is invalid: {runtime}")

    ffmpeg = media_destination / "ffmpeg.exe"
    encoders = subprocess.run(
        [str(ffmpeg), "-hide_banner", "-encoders"], check=True, capture_output=True, text=True,
    ).stdout
    filters = subprocess.run(
        [str(ffmpeg), "-hide_banner", "-filters"], check=True, capture_output=True, text=True,
    ).stdout
    for required_filter in ("zscale", "tonemap"):
        if required_filter not in filters:
            raise RuntimeError(f"Bundled FFmpeg lacks the HDR preview filter: {required_filter}")
    bitstream_filters = subprocess.run(
        [str(ffmpeg), "-hide_banner", "-bsfs"], check=True, capture_output=True, text=True,
    ).stdout
    if "setts" not in bitstream_filters:
        raise RuntimeError("Bundled FFmpeg lacks the packet-duration filter: setts")
    for encoder in ("libx264", "libx265"):
        if encoder not in encoders:
            raise RuntimeError(f"Bundled FFmpeg does not provide {encoder}.")
        encoder_help = subprocess.run(
            [str(ffmpeg), "-hide_banner", "-h", f"encoder={encoder}"],
            check=True, capture_output=True, text=True,
        ).stdout
        for pixel_format in ("yuv420p", "yuv422p", "yuv444p", "yuv420p10le", "yuv422p10le", "yuv444p10le"):
            if pixel_format not in encoder_help:
                raise RuntimeError(f"Bundled {encoder} lacks required pixel format: {pixel_format}")
    subprocess.run([
        str(ffmpeg), "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=s=256x144:r=12:d=1",
        "-frames:v", "2", "-c:v", "libx265", "-preset", "veryfast", "-pix_fmt", "yuv420p10le",
        "-x265-params", "log-level=error:pools=2:frame-threads=2", "-f", "null", "-",
    ], check=True, timeout=60)
    subprocess.run([
        str(ffmpeg), "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "color=c=black:s=7680x4320:r=1:d=1",
        "-frames:v", "1", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
        "-pix_fmt", "yuv420p", "-f", "null", "-",
    ], check=True, timeout=60)

    manifest = {
        "schema_version": 1,
        "runtime_id": RUNTIME_ID,
        "python": "3.12.13",
        "numpy": runtime["numpy"],
        "opencv": runtime["opencv"],
        "onnxruntime": runtime["onnxruntime"],
        "providers": runtime["providers"],
        "media_encoder": "libx264",
        "media_encoders": ["libx264", "libx265"],
        "files": {
            **vc_runtime_hashes,
            "python/python.exe": sha256(python_destination / "python.exe"),
            "ffmpeg/ffmpeg.exe": sha256(ffmpeg),
            "ffmpeg/ffprobe.exe": sha256(media_destination / "ffprobe.exe"),
        },
    }
    (DESTINATION / "runtime-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8",
    )
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
