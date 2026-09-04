#!/usr/bin/env python3
import hashlib, shutil, subprocess, tarfile
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
ARCHIVE=ROOT/".build/Sparkle-2.9.6.tar.xz"
SHA="52bf9e88cdd972fc0c81501377a880e90d47031bd8ca5462488f843e2609e192"

def run(*args): return subprocess.check_output(list(map(str,args)),text=True)
def main():
    ARCHIVE.parent.mkdir(parents=True,exist_ok=True)
    if not ARCHIVE.exists():
        partial=ARCHIVE.with_suffix(".partial")
        run("curl","--fail","--location","--retry","3","--max-time","180","-o",partial,"https://github.com/sparkle-project/Sparkle/releases/download/2.9.6/Sparkle-2.9.6.tar.xz")
        partial.replace(ARCHIVE)
    if hashlib.file_digest(ARCHIVE.open("rb"),"sha256").hexdigest()!=SHA: raise RuntimeError("Sparkle checksum mismatch")
    vendor=ROOT/"Vendor";vendor.mkdir(exist_ok=True)
    with tarfile.open(ARCHIVE) as tar:
        tar.extractall(vendor,members=[m for m in tar.getmembers() if m.name.removeprefix("./").startswith("Sparkle.framework/")],filter="data")
        development=ROOT/".tools/Sparkle"
        development.mkdir(parents=True,exist_ok=True)
        tar.extractall(development,members=[m for m in tar.getmembers() if m.name.removeprefix("./").startswith("bin/")],filter="data")
    framework=vendor/"Sparkle.framework"
    binaries=[]
    for path in framework.rglob("*"):
        if path.is_symlink() or not path.is_file(): continue
        if "Mach-O" not in run("file","-b",path): continue
        arch=run("lipo","-archs",path).split()
        if "arm64" not in arch: raise RuntimeError(f"Missing arm64: {path}")
        if len(arch)>1:
            temp=path.with_suffix(".arm64");run("lipo",path,"-thin","arm64","-output",temp);temp.replace(path)
        binaries.append(path)
    for path in binaries:run("codesign","--force","--sign","-","--preserve-metadata=entitlements",path)
    bundles=list(framework.rglob("*.xpc"))+list(framework.rglob("*.app"))
    for path in sorted(bundles,key=lambda p:len(p.parts),reverse=True):run("codesign","--force","--sign","-",path)
    run("codesign","--force","--sign","-",framework)
    print("Prepared Sparkle 2.9.6 arm64")

if __name__ == "__main__":main()
