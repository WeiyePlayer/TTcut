"""Bounded model probes shared by component checks and analysis workers."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import platform
import sys
import tempfile
import time

import numpy as np

from .errors import DirectMLFallbackRequired
from .onnx_models import LoadedBlurBall, _ort, create_session, model_sha256

BATCHES = (16, 8, 4, 2, 1)
CACHE_SECONDS = 3600


def device_identity() -> list:
    # DML uses adapter 0 by default. Include every adapter and driver so a
    # driver upgrade or GPU change invalidates even a cached CPU fallback.
    if sys.platform != "win32":
        return [platform.platform()]
    import winreg
    adapters = []
    with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,
                        r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}") as root:
        for index in range(winreg.QueryInfoKey(root)[0]):
            name = winreg.EnumKey(root, index)
            if not name.isdigit():
                continue
            with winreg.OpenKey(root, name) as key:
                values = []
                for field in ("DriverDesc", "DriverVersion", "MatchingDeviceId", "AdapterLuid"):
                    try:
                        values.append(str(winreg.QueryValueEx(key, field)[0]))
                    except OSError:
                        values.append("")
                adapters.append([name, *values])
    return adapters


def cache_path(model: Path) -> Path | None:
    try:
        identity = [2, model_sha256(model), _ort().__version__, sys.executable,
                    platform.version(), device_identity(), "ORT_DISABLE_ALL", "adapter0"]
        key = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
        root = Path(os.environ.get("TTCUT_DIRECTML_CACHE_DIR") or
                    str(Path(os.environ.get("LOCALAPPDATA", tempfile.gettempdir())) / "TTcut" / "directml-probes"))
        return root / f"{key}.json"
    except OSError:
        # Unknown device identity must not share another machine's cache.
        return None


def read_cache(path: Path | None) -> dict:
    try:
        value = json.loads(path.read_text()) if path else {}
        if isinstance(value, dict) and 0 <= time.time() - value.get("time", 0) < CACHE_SECONDS:
            return value
    except (OSError, ValueError, TypeError):
        pass
    return {}


def write_cache(path: Path | None, value: dict) -> None:
    if path is None:
        return
    temporary = None
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False, encoding="utf-8") as handle:
            temporary = Path(handle.name)
            json.dump({**value, "time": time.time()}, handle)
        os.replace(temporary, path)
    except OSError as error:
        print(f"DirectML probe cache could not be saved: {error}", file=sys.stderr)
    finally:
        if temporary:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass


def remember_failure(model: str | Path, reason: str) -> None:
    if Path(model).is_file():
        write_cache(cache_path(Path(model)), {"provider": "cpu", "reason": reason})


def select_configuration(model: str | Path, width: int = 512, height: int = 288) -> dict:
    model = Path(model)
    path = cache_path(model)
    cached = read_cache(path)
    shape = f"{width}x{height}"
    if cached.get("provider") == "cpu":
        return {"provider": "cpu", "batch_size": 4, "reason": str(cached.get("reason", "Cached DirectML failure"))}
    batches = cached.get("shapes", {})
    if isinstance(batches, dict) and batches.get(shape) in BATCHES:
        return {"provider": "directml", "batch_size": batches[shape], "reason": ""}
    failures = []
    # A killed/native-crashed probe leaves a short-lived CPU marker instead of
    # causing every subsequent task to crash on the same driver/model.
    write_cache(path, {"provider": "cpu", "reason": "DirectML probe did not complete"})
    for batch in BATCHES:
        loaded = inputs = output = None
        try:
            loaded = LoadedBlurBall(create_session(model, "directml"), "directml", model)
            # Three RGB frames, with nonconstant normalized image values. Use
            # the real ROI dimensions, not a tiny shape that bypasses Resize.
            sample = np.linspace(-2.0, 2.5, 9 * height * width, dtype=np.float32).reshape(1, 9, height, width)
            inputs = np.repeat(sample, batch, axis=0)
            output = loaded.run(inputs)
            if output.shape != (batch, 3, height, width):
                raise DirectMLFallbackRequired(f"Unexpected BlurBall output shape: {output.shape}", retry_smaller_batch=False)
            shapes = batches if isinstance(batches, dict) else {}
            write_cache(path, {"provider": "directml", "shapes": {**shapes, shape: batch}})
            print(f"DirectML model probe passed: {shape}, batch={batch}", file=sys.stderr)
            return {"provider": "directml", "batch_size": batch, "reason": "; ".join(failures)}
        except (DirectMLFallbackRequired, MemoryError) as error:
            failures.append(f"DirectML batch {batch}: {error}; cause={error.__cause__}")
            print(failures[-1], file=sys.stderr)
            if isinstance(error, DirectMLFallbackRequired) and not error.retry_smaller_batch:
                break
        finally:
            del loaded, inputs, output
    reason = "; ".join(failures)
    write_cache(path, {"provider": "cpu", "reason": reason})
    return {"provider": "cpu", "batch_size": 4, "reason": reason}
