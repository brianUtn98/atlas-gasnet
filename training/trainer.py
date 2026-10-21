"""Deterministic small MLP; this module has no access to test partitions."""

import math
import platform
import random
import subprocess
from dataclasses import asdict, dataclass
from importlib.metadata import version

import numpy as np
import torch
from torch import nn
from torch.utils.data import DataLoader, TensorDataset


@dataclass
class TrainConfig:
    seed: int = 42
    learning_rate: float = 0.001
    batch_size: int = 64
    max_epochs: int = 500
    patience: int = 25
    min_delta: float = 0.000001
    device: str = "cpu"
    threads: int = 1

    def validate(self):
        for key in ("batch_size", "max_epochs", "patience", "threads"):
            if type(getattr(self, key)) is not int or getattr(self, key) < 1:
                raise ValueError(f"Invalid {key}")
        if type(self.seed) is not int or not 0 <= self.seed < 2**32:
            raise ValueError("Invalid seed")
        for key in ("learning_rate", "min_delta"):
            value = getattr(self, key)
            if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
                raise ValueError(f"Invalid {key}")
        if self.learning_rate == 0 or self.device not in ("cpu", "cuda"):
            raise ValueError("Invalid learning rate/device")
        if self.device == "cuda" and not torch.cuda.is_available():
            raise ValueError("CUDA unavailable")


class GasMLP(nn.Sequential):
    def __init__(self, dimension):
        if type(dimension) is not int or dimension < 1:
            raise ValueError("Invalid input dimension")
        super().__init__(
            nn.Linear(dimension, 64), nn.ReLU(), nn.Linear(64, 32), nn.ReLU(), nn.Linear(32, 1)
        )


class EarlyStopping:
    def __init__(self, patience, min_delta):
        self.patience, self.min_delta = patience, min_delta
        self.best_loss, self.best_epoch, self.bad_epochs = math.inf, None, 0
        self.weights = None

    def observe(self, loss, model, epoch):
        if not math.isfinite(loss):
            raise ValueError("Nonfinite validation loss")
        if loss < self.best_loss - self.min_delta:
            self.best_loss, self.best_epoch, self.bad_epochs = loss, epoch, 0
            self.weights = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
        else:
            self.bad_epochs += 1
        return self.bad_epochs >= self.patience

    def restore(self, model):
        if self.weights is None:
            raise ValueError("No best checkpoint")
        model.load_state_dict(self.weights)


def epoch_loss(model, loader, device, optimizer=None):
    training = optimizer is not None
    model.train(training)
    total, count = 0.0, 0
    with torch.set_grad_enabled(training):
        for x, y in loader:
            x, y = x.to(device), y.to(device)
            if training:
                optimizer.zero_grad()
            loss = nn.functional.mse_loss(model(x), y)
            if not torch.isfinite(loss):
                raise ValueError("Nonfinite loss")
            if training:
                loss.backward()
                if any(
                    p.grad is not None and not torch.isfinite(p.grad).all()
                    for p in model.parameters()
                ):
                    raise ValueError("Nonfinite gradients")
                optimizer.step()
            total += float(loss.detach()) * len(x)
            count += len(x)
    if not count:
        raise ValueError("Empty loader")
    return total / count


def runtime(config):
    try:
        revision = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], text=True, stderr=subprocess.DEVNULL
        ).strip()
    except (OSError, subprocess.CalledProcessError):
        revision = "unavailable"
    return {
        "python": platform.python_version(),
        "platform": platform.platform(),
        "libraries": {
            n: version(n) for n in ("torch", "numpy", "pandas", "pyarrow", "scikit-learn")
        },
        "device": config.device,
        "threads": config.threads,
        "num_workers": 0,
        "deterministic_algorithms": True,
        "code_revision": revision,
        "working_tree_may_have_changes": True,
    }


def train(train_x, train_y, validation_x, validation_y, config=None):
    config = config or TrainConfig()
    config.validate()
    for x, y in ((train_x, train_y), (validation_x, validation_y)):
        if (
            x.ndim != 2
            or y.shape != (len(x), 1)
            or not len(x)
            or not torch.isfinite(x).all()
            or not torch.isfinite(y).all()
            or (y <= 0).any()
            or x.shape[1] != train_x.shape[1]
        ):
            raise ValueError("Invalid/empty split tensors")
    random.seed(config.seed)
    np.random.seed(config.seed)
    torch.manual_seed(config.seed)
    torch.set_num_threads(config.threads)
    torch.use_deterministic_algorithms(True)
    if config.device == "cuda":
        torch.cuda.manual_seed_all(config.seed)
        torch.backends.cudnn.benchmark = False
        torch.backends.cudnn.deterministic = True
    generator = torch.Generator().manual_seed(config.seed)
    exact = train_y.to(torch.float64)
    mean, scale = float(exact.mean()), float(exact.std(correction=0))
    scale = scale if scale > 0 else 1.0
    target = {"version": 1, "mean": mean, "scale": scale, "fit_split": "train", "unit": "gas"}
    train_loader = DataLoader(
        TensorDataset(train_x.float(), ((exact - mean) / scale).float()),
        batch_size=config.batch_size,
        shuffle=True,
        generator=generator,
        num_workers=0,
    )
    val_loader = DataLoader(
        TensorDataset(validation_x.float(), ((validation_y.double() - mean) / scale).float()),
        batch_size=config.batch_size,
        shuffle=False,
        num_workers=0,
    )
    model = GasMLP(train_x.shape[1]).to(config.device)
    optimizer = torch.optim.Adam(model.parameters(), lr=config.learning_rate)
    stopper = EarlyStopping(config.patience, config.min_delta)
    history = {"loss": "sample_weighted_normalized_MSE", "epochs": [], "stop_reason": "epoch_limit"}
    for epoch in range(1, config.max_epochs + 1):
        training_loss = epoch_loss(model, train_loader, config.device, optimizer)
        validation_loss = epoch_loss(model, val_loader, config.device)
        history["epochs"].append(
            {"epoch": epoch, "train": training_loss, "validation": validation_loss}
        )
        if stopper.observe(validation_loss, model, epoch):
            history["stop_reason"] = "patience"
            break
    stopper.restore(model)
    history["best_epoch"] = stopper.best_epoch
    model.cpu().eval()
    return model, target, history, {"configuration": asdict(config), "runtime": runtime(config)}


def predict(model, x, target):
    model.eval()
    with torch.no_grad():
        values = model(x.float()).double() * target["scale"] + target["mean"]
    if not torch.isfinite(values).all():
        raise ValueError("Nonfinite predictions")
    return values.flatten().tolist()
