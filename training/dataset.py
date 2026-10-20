"""Load the committed snapshot without RPC access or preprocessing refits."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import torch
from torch.utils.data import Dataset

DEFAULT_ROOT = Path(__file__).resolve().parents[1] / "data/poc/v1"


class GasDataset(Dataset):
    def __init__(self, split: str = "train", root: Path = DEFAULT_ROOT, baseline: bool = False):
        if split not in ("train", "validation", "test", "unseen-contract"):
            raise ValueError("Unknown dataset split")
        root = Path(root)
        manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
        for name in (f"{split}.pt", "preprocessing.json"):
            actual = hashlib.sha256((root / name).read_bytes()).hexdigest()
            if actual != manifest["artifacts"][name]["sha256"]:
                raise ValueError(f"Dataset artifact integrity check failed: {name}")
        data = torch.load(root / f"{split}.pt", map_location="cpu", weights_only=True)
        if data["preprocessing_sha256"] != manifest["artifacts"]["preprocessing.json"]["sha256"]:
            raise ValueError("Preprocessing identity mismatch")
        self.inputs = data["X_baseline" if baseline else "X"]
        self.targets = data["y"]
        self.raw_gas_used = data["gas_used"]
        self.row_ids = data["row_ids"]
        self.feature_names = data["baseline_feature_names" if baseline else "feature_names"]
        expected_rows = manifest["splits"][split]["rows"]
        if (
            data["split"] != split
            or data["version"] != 1
            or self.inputs.shape != (expected_rows, len(self.feature_names))
        ):
            raise ValueError("Invalid dataset shape/identity")
        if self.targets.shape != (expected_rows, 1) or len(self.row_ids) != expected_rows:
            raise ValueError("Invalid target/identity alignment")
        if not torch.isfinite(self.inputs).all() or not torch.isfinite(self.targets).all():
            raise ValueError("Dataset contains non-finite values")

    def __len__(self) -> int:
        return len(self.targets)

    def __getitem__(self, index: int) -> tuple[torch.Tensor, torch.Tensor]:
        return self.inputs[index], self.targets[index]
