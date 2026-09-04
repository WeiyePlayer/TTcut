#!/usr/bin/env python3
"""Archive, relocate, audit and package. This script never uploads or publishes."""
import hashlib, json, os, plistlib, shutil, subprocess, sys, tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output"

def run(*args, **kwargs):
    print("+", " ".join(map(str,args)), flush=True)
    return subprocess.run(list(map(str,args)), cwd=ROOT, check=True, **kwargs)

def main():
    OUTPUT.mkdir(exist_ok=True)
    verification = OUTPUT / "verification"
    verification.mkdir(exist_ok=True)
    run("xcodegen", "generate")
    archive = OUTPUT / "TTcut.xcarchive"
    with (ROOT / "archive.log").open("w") as log:
        run("xcodebuild", "-project", ROOT / "TTcut.xcodeproj", "-scheme", "TTcut", "-configuration", "Release",
            "-derivedDataPath", ROOT / ".build/xcode", "-archivePath", archive, "archive", stdout=log, stderr=subprocess.STDOUT)
    built = archive / "Products/Applications/TTcut.app"
    info = plistlib.loads((built / "Contents/Info.plist").read_bytes())
    version = info["CFBundleShortVersionString"]
    build = info["CFBundleVersion"]
    with tempfile.TemporaryDirectory(prefix="ttcut-relocated-") as temporary:
        relocated = Path(temporary) / "A folder with spaces/TTcut.app"
        relocated.parent.mkdir()
        run("ditto", built, relocated)
        run(sys.executable, ROOT / "scripts/verify_bundle.py", relocated, verification / "release-bundle.json")
        run(sys.executable, ROOT / "scripts/verify_standalone.py", relocated, verification / "standalone")
    stage = OUTPUT / "dmg-stage"
    if stage.exists(): shutil.rmtree(stage)
    stage.mkdir()
    run("ditto", built, stage / "TTcut.app")
    (stage / "Applications").symlink_to("/Applications")
    (stage / "安装说明.txt").write_text(
        "TTcut for macOS 15+ · Apple Silicon (arm64)\n\n"
        "将 TTcut.app 拖入 Applications 后打开。应用已内置模型、FFmpeg 和 ffprobe，无需安装组件。\n"
        "当前构建使用本地 ad-hoc 签名，未使用 Developer ID，也未公证。\n"
        "如 macOS 阻止首次打开，请使用系统设置 > 隐私与安全性中的系统允许入口。\n"
        "真实比赛/8K/HDR 素材质量验收暂缓；请阅读草稿附带的验证报告。\n\n"
        "Drag TTcut.app to Applications. Models and media tools are included.\n"
        "This build is ad-hoc signed and is not notarized. Use macOS Privacy & Security if first launch is blocked.\n")
    dmg = OUTPUT / f"TTcut-{version}-macOS-arm64-build{build}.dmg"
    if dmg.exists(): dmg.unlink()
    run("hdiutil", "create", "-volname", "TTcut", "-srcfolder", stage, "-fs", "HFS+", "-format", "UDZO", dmg)
    run("hdiutil", "verify", dmg)
    digest = hashlib.file_digest(dmg.open("rb"), "sha256").hexdigest()
    (OUTPUT / "SHA256SUMS").write_text(f"{digest}  {dmg.name}\n")
    report = dict(version=version,build=build,architecture="arm64",minimum_os="15.0",dmg=dmg.name,
        sha256=digest,bytes=dmg.stat().st_size,signature="ad-hoc",notarized=False,
        source_commit=subprocess.check_output(["git","rev-parse","HEAD"],cwd=ROOT,text=True).strip(),
        source_dirty=bool(subprocess.check_output(["git","status","--porcelain","--","macos"],cwd=ROOT,text=True).strip()))
    (verification / "package.json").write_text(json.dumps(report,indent=2)+"\n")
    print(f"Packaged {dmg}; upload is a separate draft-only action")

if __name__ == "__main__": main()
