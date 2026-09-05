#!/usr/bin/env python3
"""Prepare development dependencies and verified runtime assets. Nothing runs in the product."""
import platform, shutil, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def run(*args):
    print("+", " ".join(map(str, args)), flush=True)
    subprocess.run(list(map(str, args)), cwd=ROOT, check=True)

def main():
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise RuntimeError("Build on an Apple Silicon Mac")
    if sys.version_info < (3, 11, 8):
        raise RuntimeError("Use Python 3.11.8 or later; conversion was verified with Python 3.11.16")
    for command in ["git", "curl", "make", "cmake", "ninja", "autoconf", "automake", "pkg-config", "xcodegen", "xcodebuild", "xcrun"]:
        if not shutil.which(command): raise RuntimeError(f"Missing development tool: {command}; see macos/README.md")
    python = ROOT / ".venv/bin/python"
    if not python.exists(): run(sys.executable, "-m", "venv", ROOT / ".venv")
    run(python, "-m", "pip", "install", "-r", ROOT / "requirements-conversion.lock")
    run(python, ROOT / "scripts/prepare_models.py")
    run(python, ROOT / "scripts/build_native_dependencies.py")
    run(python, ROOT / "scripts/prepare_sparkle.py")
    compiled = ROOT / "Resources/Models/compiled"
    compiled.mkdir(parents=True, exist_ok=True)
    for name in ["BlurBall", "Table"]:
        package = ROOT / "Resources/Models" / (name + ".mlpackage")
        # Rebuild BlurBall so an existing FP32 package cannot survive migration.
        args = ["--verify-only"] if package.exists() and name != "BlurBall" else []
        run(python, ROOT / "scripts/convert_models.py", name, *args)
        target = compiled / (name + ".mlmodelc")
        if target.exists(): shutil.rmtree(target)
        run("xcrun", "coremlcompiler", "compile", package, compiled)
    run(python, ROOT / "scripts/make_parity_fixtures.py")
    run(python, ROOT / "scripts/make_preprocessing_fixtures.py")
    run("xcodegen", "generate")
    print("Ready: open macos/TTcut.xcodeproj, scheme TTcut. Runtime downloads are development-only.")

if __name__ == "__main__": main()
