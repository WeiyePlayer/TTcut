import hashlib
import importlib.util
from pathlib import Path
import struct

import pytest


spec = importlib.util.spec_from_file_location(
    "stage_windows_runtime", Path(__file__).resolve().parents[2] / "scripts/stage-windows-runtime.py",
)
staging = importlib.util.module_from_spec(spec)
spec.loader.exec_module(staging)


def make_dll(path: Path, machine=0x8664):
    data = bytearray(128)
    data[:2] = b"MZ"
    struct.pack_into("<I", data, 0x3C, 64)
    data[64:68] = b"PE\0\0"
    struct.pack_into("<H", data, 68, machine)
    path.write_bytes(data)


def test_bundles_msvcp_dependencies_and_records_hashes(tmp_path):
    source = tmp_path / "redist"
    source.mkdir()
    for name in (*staging.VC_RUNTIME_FILES, "msvcp140_2.dll"):
        make_dll(source / name)
    destination = tmp_path / "python"
    hashes = staging.stage_vc_runtime(source, destination)
    for file in source.iterdir():
        assert (destination / file.name).read_bytes() == file.read_bytes()
        assert hashes[f"python/{file.name}"] == hashlib.sha256(file.read_bytes()).hexdigest()


def test_rejects_python_only_crt_even_on_a_machine_with_system_msvcp(tmp_path):
    for name in ("vcruntime140.dll", "vcruntime140_1.dll"):
        make_dll(tmp_path / name)
    with pytest.raises(RuntimeError, match="msvcp140.dll, msvcp140_1.dll"):
        staging.stage_vc_runtime(tmp_path, tmp_path / "python")


def test_rejects_x86_before_copying(tmp_path):
    for name in staging.VC_RUNTIME_FILES:
        make_dll(tmp_path / name, 0x14C)
    destination = tmp_path / "python"
    with pytest.raises(RuntimeError, match="must be x64"):
        staging.stage_vc_runtime(tmp_path, destination)
    assert not destination.exists()


def test_explicit_redist_directory_does_not_fall_back_to_system32(monkeypatch, tmp_path):
    monkeypatch.setenv("TTCUT_VC_REDIST_SOURCE", str(tmp_path / "missing"))
    assert staging.resolve_vc_runtime() == tmp_path / "missing"
    with pytest.raises(RuntimeError, match=r"Incomplete Visual C\+\+ redistributable"):
        staging.stage_vc_runtime(staging.resolve_vc_runtime(), tmp_path / "python")
