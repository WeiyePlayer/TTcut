#!/usr/bin/env python3
"""Build only shipping dependencies for arm64/macOS 15, never use host bottles."""
from __future__ import annotations
import hashlib, json, os, shutil, subprocess, tarfile, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / ".build/native"
PREFIX = ROOT / "Vendor/native"
JOBS = "4"
SOURCES = {
    "ffmpeg": ("https://ffmpeg.org/releases/ffmpeg-9.0.1.tar.xz", "cf38e0e28c7e5605942c4a77755349b0145804a397af37eb1fb4c77cb237f635"),
    "x265": ("https://github.com/Multicorewareinc/x265/releases/download/4.3/x265_4.3.tar.gz", "83c53e4c8bbb8f1e33ed59e10a7d621d1d7801ca853910c3eb41f038b8ffb121"),
    "zimg": ("https://github.com/sekrit-twc/zimg/archive/refs/tags/release-3.0.6.tar.gz", "be89390f13a5c9b2388ce0f44a5e89364a20c1c57ce46d382b1fcc3967057577"),
    "opencv": ("https://github.com/opencv/opencv/archive/refs/tags/4.11.0.tar.gz", "9a7c11f924eff5f8d8070e297b322ee68b9227e003fd600d4b8122198091665f"),
}
env = os.environ.copy()
env.update(MACOSX_DEPLOYMENT_TARGET="15.0", CFLAGS="-O2 -mmacosx-version-min=15.0", CXXFLAGS="-O2 -mmacosx-version-min=15.0",
           PKG_CONFIG_PATH=str(PREFIX / "lib/pkgconfig"), PATH="/opt/homebrew/bin:" + env["PATH"])

def run(args, cwd=None):
    print("+", " ".join(map(str, args)), flush=True)
    subprocess.run(list(map(str, args)), cwd=cwd, env=env, check=True)

def source(name):
    target = WORK / name
    if target.exists(): return target
    url, expected = SOURCES[name]
    archive = WORK / (name + ".tar")
    lock_path = ROOT / "native-sources.lock.json"
    lock = json.loads(lock_path.read_text()) if lock_path.exists() else {}
    expected = expected or lock.get(name, {}).get("sha256")
    if archive.exists() and expected and hashlib.file_digest(archive.open("rb"), "sha256").hexdigest() != expected:
        archive.unlink()
    if not archive.exists():
        partial = archive.with_suffix(".partial")
        run(["curl", "--fail", "--location", "--retry", "4", "--retry-all-errors", "--connect-timeout", "20", "--max-time", "240", "--output", partial, url])
        if expected and hashlib.file_digest(partial.open("rb"), "sha256").hexdigest() != expected:
            raise RuntimeError(f"Source digest mismatch: {name}")
        partial.replace(archive)
    digest = hashlib.file_digest(archive.open("rb"), "sha256").hexdigest()
    if expected and digest != expected: raise RuntimeError(f"Source digest mismatch: {name}")
    lock[name] = {"url": url, "sha256": digest}
    lock_path.write_text(json.dumps(lock, indent=2) + "\n")
    unpack = WORK / (name + "-unpack"); unpack.mkdir(exist_ok=True)
    with tarfile.open(archive) as tar: tar.extractall(unpack, filter="data")
    next(unpack.iterdir()).rename(target)
    unpack.rmdir()
    return target

def cmake(source_dir, build_dir, extra):
    run(["cmake", "-S", source_dir, "-B", build_dir, "-G", "Ninja", "-DCMAKE_BUILD_TYPE=Release",
         "-DCMAKE_OSX_ARCHITECTURES=arm64", "-DCMAKE_OSX_DEPLOYMENT_TARGET=15.0", f"-DCMAKE_INSTALL_PREFIX={PREFIX}",
         "-DCMAKE_POLICY_VERSION_MINIMUM=3.5", *extra])
    run(["cmake", "--build", build_dir, "-j", JOBS])

def main():
    WORK.mkdir(parents=True, exist_ok=True); PREFIX.mkdir(parents=True, exist_ok=True)
    if not (PREFIX / "lib/libx264.dylib").exists():
        x264 = WORK / "x264"
        if not x264.exists():
            run(["git", "clone", "https://code.videolan.org/videolan/x264.git", x264])
        run(["git", "checkout", "b35605ace3ddf7c1a5d67a2eb553f034aef41d55"], x264)
        run(["./configure", f"--prefix={PREFIX}", "--enable-shared", "--disable-cli", "--bit-depth=all", "--chroma-format=all"], x264)
        run(["make", "-j", JOBS], x264); run(["make", "install"], x264)
    if not (PREFIX / "lib/libx265.dylib").exists():
        src = source("x265") / "source"; ten = WORK / "x265-10"; eight = WORK / "x265-8"
        cmake(src, ten, ["-DHIGH_BIT_DEPTH=ON", "-DMAIN12=OFF", "-DEXPORT_C_API=OFF", "-DENABLE_SHARED=OFF", "-DENABLE_CLI=OFF", "-DENABLE_ASSEMBLY=OFF"])
        eight.mkdir(exist_ok=True); shutil.copy2(ten / "libx265.a", eight / "libx265_main10.a")
        cmake(src, eight, ["-DHIGH_BIT_DEPTH=OFF", "-DLINKED_10BIT=ON", "-DENABLE_SHARED=ON", "-DENABLE_CLI=OFF", "-DENABLE_ASSEMBLY=OFF",
                           "-DEXTRA_LIB=x265_main10.a", f"-DEXTRA_LINK_FLAGS=-L{eight}"])
        run(["cmake", "--install", eight])
    if not (PREFIX / "lib/libzimg.dylib").exists():
        src = source("zimg")
        run(["./autogen.sh"], src)
        run(["./configure", f"--prefix={PREFIX}", "--enable-shared", "--disable-static"], src)
        run(["make", "-j", JOBS], src); run(["make", "install"], src)
    if not (PREFIX / "bin/ffmpeg").exists():
        src = source("ffmpeg")
        run(["./configure", f"--prefix={PREFIX}", "--arch=arm64", "--enable-shared", "--disable-static", "--disable-doc", "--disable-debug", "--disable-ffplay",
             "--disable-autodetect", "--enable-gpl", "--enable-libx264", "--enable-libx265", "--enable-libzimg", "--enable-videotoolbox", "--enable-audiotoolbox",
             "--extra-cflags=-mmacosx-version-min=15.0", f"--extra-ldflags=-mmacosx-version-min=15.0 -Wl,-rpath,{PREFIX / 'lib'}"], src)
        run(["make", "-j", JOBS], src); run(["make", "install"], src)
    if not (PREFIX / "lib/libopencv_imgproc.a").exists():
        src = source("opencv"); build = WORK / "opencv-build"
        cmake(src, build, ["-DBUILD_LIST=core,imgproc", "-DBUILD_SHARED_LIBS=OFF", "-DBUILD_TESTS=OFF", "-DBUILD_PERF_TESTS=OFF", "-DBUILD_EXAMPLES=OFF",
                           "-DBUILD_opencv_apps=OFF", "-DWITH_IPP=OFF", "-DWITH_OPENCL=OFF", "-DWITH_LAPACK=OFF", "-DWITH_EIGEN=OFF", "-DWITH_ITT=OFF", "-DBUILD_JAVA=OFF",
                           "-DBUILD_opencv_python2=OFF", "-DBUILD_opencv_python3=OFF"])
        run(["cmake", "--install", build])
    run([PREFIX / "bin/ffmpeg", "-hide_banner", "-encoders"])
    print("Native macOS 15 dependencies ready", flush=True)

if __name__ == "__main__": main()
