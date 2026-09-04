#!/usr/bin/env python3
"""Collect only reviewable reports and this app's synthetic view renders for a draft."""
import hashlib, json, re, shutil, subprocess, zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "output"

def main():
    source = OUT / "verification"
    package = json.loads((source / "package.json").read_text())
    dmg = OUT / package["dmg"]
    assert hashlib.file_digest(dmg.open("rb"), "sha256").hexdigest() == package["sha256"]
    folder = OUT / "release-evidence"
    if folder.exists(): shutil.rmtree(folder)
    folder.mkdir()
    def write(name, value):
        text = json.dumps(value, indent=2, ensure_ascii=False) + "\n"
        text = text.replace(str(ROOT.parent), "$PROJECT").replace(str(Path.home()), "$USER_HOME")
        (folder / name).write_text(text)
    for filename in ["BlurBall-conversion.json", "Table-conversion.json", "package.json", "dmg.json"]:
        value = json.loads((source / filename).read_text())
        if "passed" in value: assert value["passed"], filename
        write(filename, value)
    bundle = json.loads((source / "release-bundle.json").read_text())
    bundle["app"] = "$RELOCATED_APP"
    write("release-bundle.json", bundle)
    standalone = json.loads((source / "standalone/standalone.json").read_text())
    assert standalone["passed"]
    write("standalone.json", standalone)
    updates = json.loads((source / "local-update.json").read_text())
    assert all(test["passed"] for test in updates["results"])
    write("local-update.json", updates)
    workflow_path = max(OUT.glob("workflow-test*/workflow.json"), key=lambda path: path.stat().st_mtime)
    workflow = json.loads(workflow_path.read_text())
    assert workflow["passed"]
    write("workflow.json", workflow)
    ui = json.loads((source / "ui-tests.json").read_text())
    assert ui["result"] == "Passed" and ui["passedTests"] == 2 and ui["failedTests"] == 0
    write("ui-tests.json", {key: ui[key] for key in ["title", "result", "totalTestCount", "passedTests", "failedTests", "skippedTests", "environmentDescription"]})
    tests = (ROOT / "native-tests.log").read_text()
    assert "Test Suite 'All tests' passed" in tests
    count = int(re.findall(r"Executed (\d+) tests, with 0 failures", tests)[-1])
    assert count >= 21
    write("native-tests.json", dict(passed=True, count=count, synthetic_only=True,
        tests=re.findall(r"Test Case '-\[([^\]]+)\]' passed", tests)))
    unchanged = not subprocess.check_output(["git", "diff", "b9e359b3b7ea113dd5b23f203b03e53fb7690d88", "--",
        "src", "worker", "tests", "scripts", ".github", "package-lock.json"], cwd=ROOT.parent)
    assert unchanged, "Windows baseline changed; review the regression statement"
    typecheck = (ROOT / "windows-typecheck.log").read_text()
    assert "tsc --noEmit" in typecheck and "error TS" not in typecheck
    python_count = int(re.findall(r"(\d+) passed", (ROOT / "windows-python-tests.log").read_text())[-1])
    vitest = re.sub(r"\x1b\[[0-9;]*m", "", (ROOT / "windows-vitest.log").read_text())
    line = [line for line in vitest.splitlines() if line.strip().startswith("Tests ")][-1]
    counts = {status: int(re.search(r"(\d+) " + status, line).group(1)) for status in ["passed", "failed", "skipped"]}
    write("windows-regression.json", dict(source_unchanged=unchanged,typescript_typecheck="passed",python_tests_passed=python_count,
        vitest_on_macos=counts,windows_native_execution=False,
        failure_areas=["Windows installation paths/registration", "Windows updater platform", "PowerShell certificate signing", "Windows file URL"]))
    for name in ["README.md", "VERIFICATION.md", "BEHAVIOR_PARITY.md"]: shutil.copy2(ROOT / name, folder / name)
    images = folder / "screenshots"
    images.mkdir()
    for name in ["home", "settings", "settings-en", "calibration", "custom", "custom-en", "history-empty", "history", "batch"]:
        shutil.copy2(OUT / "screenshots" / (name + ".png"), images / (name + ".png"))
    (images / "README.txt").write_text("Own-view renders with synthetic fixtures. These images do not claim real detections. Bitmap rendering does not capture the native AVPlayer layer; actual UI tests and player readiness/seek are reported separately.\n")
    archive = OUT / "TTcut-1.2.10-macOS-arm64-verification.zip"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as target:
        for path in sorted(folder.rglob("*")):
            if path.is_file(): target.write(path, path.relative_to(folder))
    sums = [f"{hashlib.file_digest(path.open('rb'), 'sha256').hexdigest()}  {path.name}" for path in [dmg, archive]]
    (OUT / "SHA256SUMS").write_text("\n".join(sums) + "\n")
    print(f"Prepared {archive.name}: {count} native tests, {len(workflow['checks'])} workflows, 2 UI tests and verified package")

if __name__ == "__main__": main()
