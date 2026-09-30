"""Distill the full Huji score distribution into MobileNetV3-Small 1.0."""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import platform
import random
import time
from collections import Counter, defaultdict
from pathlib import Path

import torch
import torch.nn.functional as functional
import torchvision
from PIL import Image
from torch import nn
from torch.utils.data import DataLoader, Dataset
from torchvision.models import MobileNet_V3_Small_Weights, mobilenet_v3_small
from torchvision.transforms.functional import normalize, to_tensor

from .common import CLASSES, MODEL_SHA256, atomic_json, sha256_file


SEED = 20260925
IMAGENET_MEAN = (0.485, 0.456, 0.406)
IMAGENET_STD = (0.229, 0.224, 0.225)
PADDING = tuple((114 / 255 - mean) / std for mean, std in zip(IMAGENET_MEAN, IMAGENET_STD))


class StudentFrames(Dataset):
    def __init__(self, root: Path, rows: list[dict[str, str]]):
        self.root = root
        self.rows = rows

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(self, index: int):
        row = self.rows[index]
        with Image.open(self.root / row["image_path"]) as image:
            rgb = image.convert("RGB")
            if rgb.size != (int(row["student_width"]), int(row["student_height"])):
                raise ValueError(f"Training image size changed: {row['image_path']}")
            tensor = normalize(to_tensor(rgb), IMAGENET_MEAN, IMAGENET_STD)
        target = torch.tensor([float(row[f"teacher_{name}"]) for name in CLASSES], dtype=torch.float32)
        return tensor, target, index


def collate(batch):
    height = max(item[0].shape[1] for item in batch)
    width = max(item[0].shape[2] for item in batch)
    images = torch.empty((len(batch), 3, height, width), dtype=torch.float32)
    for channel, value in enumerate(PADDING):
        images[:, channel].fill_(value)
    targets = torch.empty((len(batch), 3), dtype=torch.float32)
    indices = []
    for position, (image, target, index) in enumerate(batch):
        images[position, :, :image.shape[1], :image.shape[2]] = image
        targets[position] = target
        indices.append(index)
    return images, targets, indices


def build_model(pretrained: bool) -> nn.Module:
    weights = MobileNet_V3_Small_Weights.IMAGENET1K_V1 if pretrained else None
    model = mobilenet_v3_small(weights=weights, width_mult=1.0)
    input_features = model.classifier[-1].in_features
    model.classifier[-1] = nn.Linear(input_features, len(CLASSES))
    return model


def balanced_epoch_indices(rows: list[dict[str, str]], count: int, seed: int) -> list[int]:
    if count < 2:
        raise ValueError("Need at least two training draws")
    rng = random.Random(seed)
    by_video: dict[str, list[int]] = defaultdict(list)
    by_class_video: dict[str, dict[str, list[int]]] = {name: defaultdict(list) for name in CLASSES}
    for index, row in enumerate(rows):
        name = row["teacher_top1"]
        if name not in CLASSES:
            raise ValueError(f"Unknown teacher label: {name}")
        by_video[row["video_id"]].append(index)
        by_class_video[name][row["video_id"]].append(index)
    videos = sorted(by_video)
    half = count // 2
    if half < len(videos):
        raise ValueError("Epoch sample budget cannot cover every video")
    draws = [rng.choice(by_video[video]) for video in videos]
    draws.extend(rng.choice(by_video[rng.choice(videos)]) for _ in range(half - len(draws)))
    active_classes = [name for name in CLASSES if by_class_video[name]]
    if len(active_classes) != len(CLASSES):
        raise ValueError(f"All three teacher classes are required, found {active_classes}")
    for position in range(count - half):
        name = active_classes[position % len(active_classes)]
        class_videos = sorted(by_class_video[name])
        draws.append(rng.choice(by_class_video[name][rng.choice(class_videos)]))
    rng.shuffle(draws)
    return draws


def make_loader(dataset: StudentFrames, indices: list[int] | None, batch_size: int,
                workers: int) -> DataLoader:
    return DataLoader(
        dataset, batch_size=batch_size, sampler=indices, shuffle=False,
        num_workers=workers, pin_memory=torch.cuda.is_available(), collate_fn=collate,
        persistent_workers=False,
    )


def set_seed() -> None:
    random.seed(SEED)
    torch.manual_seed(SEED)
    torch.cuda.manual_seed_all(SEED)
    torch.backends.cudnn.deterministic = True
    torch.backends.cudnn.benchmark = False
    torch.use_deterministic_algorithms(True, warn_only=True)


def make_optimizer(model: nn.Module, phase: str, head_epochs: int, full_epochs: int):
    if phase == "head":
        for parameter in model.parameters():
            parameter.requires_grad = False
        for parameter in model.classifier.parameters():
            parameter.requires_grad = True
        optimizer = torch.optim.AdamW(model.classifier.parameters(), lr=1e-3, weight_decay=1e-4)
        scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=head_epochs, eta_min=1e-6)
    else:
        for parameter in model.parameters():
            parameter.requires_grad = True
        classifier = list(model.classifier.parameters())
        classifier_ids = {id(parameter) for parameter in classifier}
        backbone = [parameter for parameter in model.parameters() if id(parameter) not in classifier_ids]
        optimizer = torch.optim.AdamW(
            [{"params": backbone, "lr": 1e-4}, {"params": classifier, "lr": 5e-4}],
            weight_decay=1e-4,
        )
        scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=full_epochs, eta_min=1e-6)
    return optimizer, scheduler


def atomic_torch_save(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".tmp")
    torch.save(payload, temp)
    os.replace(temp, path)


def write_history(path: Path, history: list[dict]) -> None:
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=("epoch", "phase", "loss_kl", "elapsed_sec", "draws", "learning_rates"))
        writer.writeheader()
        writer.writerows(history)
    os.replace(temporary, path)


def train_epoch(model: nn.Module, loader: DataLoader, optimizer, scaler, device: torch.device,
                accumulation: int, phase: str) -> float:
    if phase == "head":
        model.eval()
        model.classifier.train()
    else:
        model.train()
    optimizer.zero_grad(set_to_none=True)
    loss_sum = 0.0
    samples = 0
    total_batches = len(loader)
    for batch_index, (images, targets, _) in enumerate(loader, 1):
        images = images.to(device, non_blocking=True)
        targets = targets.to(device, non_blocking=True)
        with torch.autocast(device_type=device.type, enabled=device.type == "cuda"):
            outputs = model(images)
            loss = functional.kl_div(functional.log_softmax(outputs.float(), dim=1), targets,
                                     reduction="batchmean")
        scaler.scale(loss / accumulation).backward()
        if batch_index % accumulation == 0 or batch_index == total_batches:
            scaler.step(optimizer)
            scaler.update()
            optimizer.zero_grad(set_to_none=True)
        loss_sum += float(loss.detach()) * len(images)
        samples += len(images)
    return loss_sum / samples


def agreement_report(model: nn.Module, dataset: StudentFrames, rows: list[dict[str, str]],
                     device: torch.device, batch_size: int, workers: int) -> dict:
    model.eval()
    loader = make_loader(dataset, list(range(len(dataset))), batch_size, workers)
    matrix = [[0 for _ in CLASSES] for _ in CLASSES]
    per_video: dict[str, dict] = defaultdict(lambda: {"frames": 0, "matches": 0, "kl_sum": 0.0, "mae_sum": 0.0})
    kl_sum = 0.0
    mae_sum = 0.0
    with torch.inference_mode():
        for images, targets, indices in loader:
            images = images.to(device, non_blocking=True)
            targets = targets.to(device, non_blocking=True)
            with torch.autocast(device_type=device.type, enabled=device.type == "cuda"):
                logits = model(images)
            log_scores = functional.log_softmax(logits.float(), dim=1)
            student_scores = log_scores.exp()
            kl_values = functional.kl_div(log_scores, targets, reduction="none").sum(dim=1)
            mae_values = (student_scores - targets).abs().mean(dim=1)
            predicted = student_scores.argmax(dim=1).cpu().tolist()
            teacher = targets.argmax(dim=1).cpu().tolist()
            kl_values_cpu = kl_values.cpu().tolist()
            mae_values_cpu = mae_values.cpu().tolist()
            for position, index in enumerate(indices):
                actual, prediction = teacher[position], predicted[position]
                matrix[actual][prediction] += 1
                row = rows[index]
                current = per_video[row["video_id"]]
                current["relative_path"] = row["relative_path"]
                current["frames"] += 1
                current["matches"] += int(actual == prediction)
                current["kl_sum"] += kl_values_cpu[position]
                current["mae_sum"] += mae_values_cpu[position]
                kl_sum += kl_values_cpu[position]
                mae_sum += mae_values_cpu[position]
    total = sum(sum(row) for row in matrix)
    class_metrics = {}
    for index, name in enumerate(CLASSES):
        true_positive = matrix[index][index]
        teacher_count = sum(matrix[index])
        predicted_count = sum(matrix[row][index] for row in range(len(CLASSES)))
        precision = true_positive / predicted_count if predicted_count else 0.0
        recall = true_positive / teacher_count if teacher_count else 0.0
        f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
        class_metrics[name] = {"teacher_frames": teacher_count, "predicted_frames": predicted_count,
                               "precision": precision, "recall": recall, "f1": f1}
    video_report = []
    for video, values in sorted(per_video.items()):
        count = values["frames"]
        video_report.append({"video_id": video, "relative_path": values["relative_path"],
                             "frames": count, "top1_agreement": values["matches"] / count,
                             "mean_kl": values["kl_sum"] / count,
                             "mean_score_mae": values["mae_sum"] / count})
    return {"evaluation_scope": "all training videos; no independent holdout",
            "frame_count": total, "video_count": len(video_report),
            "top1_agreement": sum(matrix[i][i] for i in range(len(CLASSES))) / total,
            "mean_kl": kl_sum / total, "mean_score_mae": mae_sum / total,
            "confusion_teacher_rows_student_columns": matrix,
            "class_metrics": class_metrics, "per_video": video_report,
            "cross_view_limitation": "Huji sees a 640 square center crop; student sees the full frame at height 256."}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-root", type=Path, default=Path("huji_student/data/v1"))
    parser.add_argument("--run-dir", type=Path, default=Path("huji_student/runs/v1"))
    parser.add_argument("--expected-videos", type=int, default=122)
    parser.add_argument("--head-epochs", type=int, default=3)
    parser.add_argument("--full-epochs", type=int, default=20)
    parser.add_argument("--samples-per-epoch", type=int, default=60000)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--accumulation", type=int, default=1)
    parser.add_argument("--workers", type=int, default=2)
    args = parser.parse_args()
    data_root = args.data_root.resolve()
    run_dir = args.run_dir.resolve()
    run_dir.mkdir(parents=True, exist_ok=True)
    dataset_meta = json.loads((data_root / "dataset.json").read_text(encoding="utf-8"))
    verification = json.loads((data_root / "verification.json").read_text(encoding="utf-8"))
    manifest = data_root / "manifest.csv"
    manifest_sha = sha256_file(manifest)
    if (not verification["valid"] or verification["video_count"] != args.expected_videos
            or verification["frame_count"] != dataset_meta["frame_count"]
            or manifest_sha != dataset_meta["manifest_sha256"]
            or manifest_sha != verification["manifest_sha256"]
            or tuple(dataset_meta["classes"]) != CLASSES):
        raise ValueError("Dataset is not fully verified or changed after verification")
    with manifest.open("r", encoding="utf-8", newline="") as stream:
        rows = list(csv.DictReader(stream))
    if len(rows) != dataset_meta["frame_count"]:
        raise ValueError("Manifest frame count changed")
    config = {
        "model": "torchvision.mobilenet_v3_small", "width_mult": 1.0,
        "imagenet_weights": MobileNet_V3_Small_Weights.IMAGENET1K_V1.name,
        "classes": CLASSES, "student_height": dataset_meta["student_height"],
        "seed": SEED, "head_epochs": args.head_epochs, "full_epochs": args.full_epochs,
        "head_trainable": "classifier",
        "samples_per_epoch": args.samples_per_epoch, "batch_size": args.batch_size,
        "accumulation": args.accumulation, "effective_batch": args.batch_size * args.accumulation,
        "workers": args.workers, "loss": "KL(teacher_softmax || student_softmax)",
        "manifest_sha256": manifest_sha, "huji_model_sha256": MODEL_SHA256,
        "all_videos_in_training": True, "independent_validation": False,
        "python_version": platform.python_version(), "torch_version": torch.__version__,
        "torchvision_version": torchvision.__version__,
        "cuda_device": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
    }
    if config["effective_batch"] != 32:
        raise ValueError("Effective batch must be 32")
    config_path = run_dir / "config.json"
    if config_path.exists():
        if json.loads(config_path.read_text(encoding="utf-8")) != json.loads(json.dumps(config)):
            raise ValueError("Run configuration changed; use a new run directory")
    else:
        atomic_json(config_path, config)
    set_seed()
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    resume_path = run_dir / "resume.pt"
    checkpoint = torch.load(resume_path, map_location="cpu", weights_only=False) if resume_path.is_file() else None
    model = build_model(pretrained=checkpoint is None)
    history: list[dict] = []
    start_epoch = 1
    if checkpoint is not None:
        if checkpoint["config"] != config:
            raise ValueError("Resume checkpoint does not match current configuration")
        model.load_state_dict(checkpoint["model"])
        history = checkpoint["history"]
        start_epoch = checkpoint["epoch"] + 1
    model.to(device)
    scaler = torch.amp.GradScaler("cuda", enabled=device.type == "cuda")
    if checkpoint is not None:
        scaler.load_state_dict(checkpoint["scaler"])
    dataset = StudentFrames(data_root, rows)
    optimizer = scheduler = None
    active_phase = None
    total_epochs = args.head_epochs + args.full_epochs
    for epoch in range(start_epoch, total_epochs + 1):
        phase = "head" if epoch <= args.head_epochs else "full"
        if phase != active_phase:
            optimizer, scheduler = make_optimizer(model, phase, args.head_epochs, args.full_epochs)
            active_phase = phase
            if checkpoint is not None and epoch == start_epoch and checkpoint["phase"] == phase:
                optimizer.load_state_dict(checkpoint["optimizer"])
                scheduler.load_state_dict(checkpoint["scheduler"])
        assert optimizer is not None and scheduler is not None
        indices = balanced_epoch_indices(rows, args.samples_per_epoch, SEED + epoch)
        loader = make_loader(dataset, indices, args.batch_size, args.workers)
        started = time.monotonic()
        loss = train_epoch(model, loader, optimizer, scaler, device, args.accumulation, phase)
        elapsed = time.monotonic() - started
        learning_rates = ",".join(f"{group['lr']:.9g}" for group in optimizer.param_groups)
        history.append({"epoch": epoch, "phase": phase, "loss_kl": loss,
                        "elapsed_sec": round(elapsed, 3), "draws": len(indices),
                        "learning_rates": learning_rates})
        scheduler.step()
        atomic_torch_save(resume_path, {"epoch": epoch, "phase": phase, "model": model.state_dict(),
                                        "optimizer": optimizer.state_dict(), "scheduler": scheduler.state_dict(),
                                        "scaler": scaler.state_dict(), "history": history, "config": config})
        write_history(run_dir / "history.csv", history)
        print(f"EPOCH {epoch}/{total_epochs} {phase} KL={loss:.6f} {elapsed:.1f}s", flush=True)
    final_path = run_dir / "student_final.pt"
    atomic_torch_save(final_path, {"model": model.state_dict(), "config": config,
                                   "completed_epochs": total_epochs, "classes": CLASSES})
    print("Evaluating teacher agreement on all training frames", flush=True)
    report = agreement_report(model, dataset, rows, device, args.batch_size, args.workers)
    report["checkpoint_sha256"] = sha256_file(final_path)
    report["manifest_sha256"] = manifest_sha
    atomic_json(run_dir / "teacher_agreement.json", report)
    print(f"COMPLETE top1 agreement={report['top1_agreement']:.4f} mean KL={report['mean_kl']:.6f}", flush=True)


if __name__ == "__main__":
    main()
