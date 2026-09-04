#!/usr/bin/env python3
"""Download the immutable Windows-reference checkpoints, verifying before use."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[2]

def main():
    manifest = json.loads((ROOT / "resources/model-manifest.json").read_text())
    delivery = json.loads((ROOT / "resources/online-model-delivery.json").read_text())
    urls = {item["filename"]: item["url"] for item in delivery["models"]}
    destination = ROOT / "resources/models"
    destination.mkdir(parents=True, exist_ok=True)
    for item in manifest["models"]:
        target = destination / item["filename"]
        def valid(path):
            return (path.is_file() and path.stat().st_size == item["size_bytes"]
                    and hashlib.file_digest(path.open("rb"), "sha256").hexdigest() == item["sha256"])
        if not valid(target):
            partial = target.with_suffix(".download")
            try:
                print(f"Downloading {item['filename']}", flush=True)
                with urllib.request.urlopen(urls[item["filename"]], timeout=60) as response, partial.open("wb") as output:
                    while chunk := response.read(1024 * 1024):
                        output.write(chunk)
                if not valid(partial):
                    raise RuntimeError(f"Checkpoint verification failed: {item['filename']}")
                partial.replace(target)
            finally:
                partial.unlink(missing_ok=True)
        print(f"Verified {item['filename']} {item['sha256']}", flush=True)

if __name__ == "__main__":
    main()
