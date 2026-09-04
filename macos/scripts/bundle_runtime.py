#!/usr/bin/env python3
"""Embed a closed arm64 runtime, rewrite install names, and ad-hoc sign it."""
import os, re, shutil, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PREFIX = ROOT / "Vendor/native"

def run(*args):
    return subprocess.check_output(list(map(str,args)), text=True)

def main():
    contents, worker = map(Path,sys.argv[1:])
    frameworks=contents/"Frameworks"; helpers=contents/"Helpers"; models=contents/"Resources/Models"
    frameworks.mkdir(parents=True,exist_ok=True); helpers.mkdir(parents=True,exist_ok=True)
    for source in (PREFIX/"lib").glob("*.dylib"):
        destination=frameworks/source.name
        if destination.is_symlink(): destination.unlink()
        if source.is_symlink():
            if destination.exists(): destination.unlink()
            destination.symlink_to(source.resolve().name)
        else: shutil.copy2(source,destination)
    for source in [PREFIX/"bin/ffmpeg",PREFIX/"bin/ffprobe",worker]: shutil.copy2(source,helpers/source.name)
    for name in ["BlurBall","Table"]:
        source=ROOT/"Resources/Models/compiled"/(name+".mlmodelc")
        if not source.is_dir(): raise RuntimeError(f"Compile {source} first")
        shutil.copytree(source,models/source.name,dirs_exist_ok=True)
    binaries=[p for p in frameworks.glob("*.dylib") if not p.is_symlink()]+list(helpers.iterdir())+list((contents/"MacOS").iterdir())
    for path in binaries:
        if run("lipo","-archs",path).strip() != "arm64": raise RuntimeError(f"Non-arm64 binary: {path}")
        subprocess.run(["codesign","--remove-signature",str(path)],capture_output=True)
        for line in run("otool","-L",path).splitlines()[1:]:
            dep=line.strip().split(" (",1)[0]
            if dep.startswith(str(PREFIX)):
                run("install_name_tool","-change",dep,"@rpath/"+Path(dep).name,path)
            elif dep.startswith("/opt/homebrew") or dep.startswith("/Users/"):
                raise RuntimeError(f"Unbundled dependency: {dep}")
        if path.parent == frameworks: run("install_name_tool","-id","@rpath/"+path.name,path)
        load=run("otool","-l",path)
        for rpath in re.findall(r"cmd LC_RPATH\s+cmdsize \d+\s+path (.*?) \(offset",load):
            if rpath.startswith(str(ROOT)) or rpath.startswith("/opt/homebrew"):
                run("install_name_tool","-delete_rpath",rpath,path)
        expected="@loader_path/../Frameworks" if path.parent in [helpers,contents/"MacOS"] else "@loader_path"
        if expected not in load: run("install_name_tool","-add_rpath",expected,path)
        # Xcode signs the main executable together with its bundle after this phase.
        if path.parent != contents/"MacOS" or path.suffix==".dylib":
            run("codesign","--force","--sign","-",path)
    print("Embedded and signed arm64 FFmpeg/ffprobe, worker, and Core ML models")

if __name__ == "__main__": main()
