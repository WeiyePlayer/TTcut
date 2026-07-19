from pathlib import Path


def test_worker_package_excludes_removed_runtime_features():
    package = Path(__file__).parents[1] / "ttcut_worker"
    text = "\n".join(path.read_text(encoding="utf-8") for path in package.glob("*.py"))
    for forbidden in ("InpaintNet", "speed_analysis", "hit_detection", "gradio", "overlay_renderer"):
        assert forbidden not in text

