#!/usr/bin/env python3
"""Fail if a relocated app needs the checkout, Homebrew, a different architecture, or a newer macOS."""
import json, os, plistlib, re, subprocess, sys
from pathlib import Path

def run(*args,env=None):return subprocess.check_output(list(map(str,args)),text=True,errors="replace",stderr=subprocess.STDOUT,env=env)
def main():
    app=Path(sys.argv[1]).resolve();contents=app/"Contents"
    info=plistlib.loads((contents/"Info.plist").read_bytes())
    assert info.get("LSMinimumSystemVersion")=="15.0",info.get("LSMinimumSystemVersion")
    assert not info.get("SUFeedURL") and not info.get("SUPublicEDKey"),"Production update configuration must remain empty"
    assert not info.get("TTcutUpdateTest"),"Test updater must not ship"
    run("codesign","--verify","--deep","--strict",app)
    binaries=[]
    for path in app.rglob("*"):
        if not path.is_file() or path.is_symlink():continue
        if "Mach-O" not in run("file","-b",path):continue
        assert run("lipo","-archs",path).strip()=="arm64",path
        load=run("otool","-l",path)
        versions=re.findall(r"minos ([\d.]+)",load) or re.findall(r"cmd LC_VERSION_MIN_MACOSX\s+cmdsize \d+\s+version ([\d.]+)",load)
        assert versions,f"No deployment version: {path}"
        for version in versions:assert tuple(map(int,version.split(".")[:2])) <= (15,0),(path,version)
        dependencies=[]
        for line in run("otool","-L",path).splitlines()[1:]:
            dependency=line.strip().split(" (",1)[0]
            assert not dependency.startswith(("/Users/","/opt/homebrew/","/usr/local/")),(path,dependency)
            if dependency.startswith("@rpath/") and not dependency.startswith("@rpath/libswift"):
                # Sparkle's embedded apps use their own Frameworks search paths; all dylibs must exist inside this app.
                name=Path(dependency).name
                assert any(p.name==name for p in app.rglob(name)),(path,dependency)
            dependencies.append(dependency)
        for rpath in re.findall(r"cmd LC_RPATH\s+cmdsize \d+\s+path (.*?) \(offset",load):
            assert not rpath.startswith(("/Users/","/opt/homebrew/","/usr/local/")),(path,rpath)
        binaries.append(dict(path=str(path.relative_to(app)),minimum_os=versions,dependencies=dependencies))
    assert len(binaries)>10
    for model in ["BlurBall","Table"]:assert (contents/"Resources/Models"/(model+".mlmodelc")).is_dir()
    for unwanted in ["*.pt","python*","libtorch*","libopenh264*","*.exe"]:assert not list(app.rglob(unwanted)),unwanted
    env={"PATH":"/usr/bin:/bin:/usr/sbin:/sbin","HOME":os.environ["HOME"],"TMPDIR":os.environ.get("TMPDIR","/tmp")}
    encoders=run(contents/"Helpers/ffmpeg","-hide_banner","-encoders",env=env)
    assert "libx264" in encoders and "libx265" in encoders
    run(contents/"Helpers/ffprobe","-version",env=env)
    report=dict(app=str(app),architecture="arm64",minimum_os="15.0",signature="ad-hoc verified",binaries=binaries)
    target=Path(sys.argv[2]) if len(sys.argv)>2 else app.parent/"bundle-verification.json"
    target.write_text(json.dumps(report,indent=2)+"\n")
    print(f"Verified {len(binaries)} Mach-O files, arm64/macOS 15, app-relative runtime, empty production update feed")

if __name__ == "__main__":main()
