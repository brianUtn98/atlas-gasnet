"""Versioned, integrity-checked preparation and selected-model bundles."""

import math
from pathlib import Path

import torch

from training.baseline import SelectorMedian, labels
from training.prepare_dataset import digest, read_json, write_json
from training.preprocessing import TrainingPreprocessor, validate_state
from training.sources import fingerprint
from training.splits import prepare_sources
from training.trainer import GasMLP, predict, train

RUN_FILES = {
    "model.pt",
    "preprocessing.json",
    "baseline.json",
    "config.json",
    "history.json",
    "provenance.json",
}


def hashes(directory, names):
    return {n: digest(directory / n) for n in sorted(names)}


def verify(directory, kind, required=None):
    directory = Path(directory)
    m = read_json(directory / "manifest.json")
    if m.get("version") != 2 or m.get("kind") != kind or m.get("complete") is not True:
        raise ValueError("Incomplete or incompatible bundle")
    if required is not None and set(m["artifacts"]) != required:
        raise ValueError("Incomplete artifact set")
    for name, expected in m["artifacts"].items():
        path = (directory / name).resolve()
        if (
            not path.is_relative_to(directory.resolve())
            or not path.is_file()
            or digest(path) != expected
        ):
            raise ValueError(f"Artifact integrity mismatch: {name}")
    return m


def prepare(source, output, mode="poc"):
    output = Path(output)
    if output.exists():
        raise ValueError("Output already exists")
    datasets, provenance = prepare_sources(Path(source), mode)
    for rows in datasets.values():
        labels(rows)
        for row in rows:
            validate_state(row)
    processor = TrainingPreprocessor().fit(datasets["train"])
    for rows in datasets.values():
        processor.transform(rows)
    output.mkdir(parents=True, exist_ok=False)
    write_json(output / "preprocessing.json", processor.metadata())
    write_json(output / "provenance.json", provenance)
    for split, rows in datasets.items():
        write_json(output / f"{split}.json", rows)
    names = {"preprocessing.json", "provenance.json", *[f"{s}.json" for s in datasets]}
    manifest = {
        "version": 2,
        "kind": "prepared",
        "complete": True,
        "splits": list(datasets),
        "pipeline_check_only": provenance["pipeline_check_only"],
        "provenance_sha256": fingerprint(provenance),
        "artifacts": hashes(output, names),
    }
    write_json(output / "manifest.json", manifest)
    return manifest


def load_prepared(directory):
    m = verify(directory, "prepared")
    expected = {"preprocessing.json", "provenance.json", *[f"{s}.json" for s in m["splits"]]}
    if set(m["artifacts"]) != expected or not {"train", "validation", "test"} <= set(m["splits"]):
        raise ValueError("Invalid prepared splits/artifacts")
    return m


def train_bundle(prepared, output, config=None):
    prepared, output = Path(prepared), Path(output)
    if output.exists():
        raise ValueError("Output already exists")
    source_manifest = load_prepared(prepared)
    # Hash-check all parts, but deserialize only train/validation for fitting and selection.
    training = read_json(prepared / "train.json")
    validation = read_json(prepared / "validation.json")
    processor = TrainingPreprocessor.from_metadata(read_json(prepared / "preprocessing.json"))
    train_x, val_x = processor.transform(training), processor.transform(validation)
    model, target, history, config_meta = train(
        train_x,
        torch.tensor(labels(training)).reshape(-1, 1),
        val_x,
        torch.tensor(labels(validation)).reshape(-1, 1),
        config,
    )
    baseline = SelectorMedian().fit(training)
    output.mkdir(parents=True, exist_ok=False)
    write_json(output / "preprocessing.json", processor.metadata())
    write_json(output / "baseline.json", baseline.data)
    write_json(output / "config.json", config_meta)
    write_json(output / "history.json", history)
    write_json(output / "provenance.json", read_json(prepared / "provenance.json"))
    features = processor.metadata()["feature_names"]
    checkpoint = {
        "version": 2,
        "architecture": [len(features), 64, 32, 1],
        "feature_names": features,
        "target_transform": target,
        "preprocessing_sha256": digest(output / "preprocessing.json"),
        "state_dict": model.state_dict(),
    }
    torch.save(checkpoint, output / "model.pt")
    # Validate safe CPU reload and numerical parity before publishing completion.
    reloaded = torch.load(output / "model.pt", map_location="cpu", weights_only=True)
    restored = GasMLP(len(features))
    restored.load_state_dict(reloaded["state_dict"])
    torch.testing.assert_close(
        torch.tensor(predict(model, val_x, target)),
        torch.tensor(predict(restored, val_x, target)),
        rtol=0,
        atol=1e-6,
    )
    manifest = {
        "version": 2,
        "kind": "run",
        "complete": True,
        "prepared_manifest_sha256": digest(prepared / "manifest.json"),
        "pipeline_check_only": source_manifest["pipeline_check_only"],
        "feature_names": features,
        "dimension": len(features),
        "selected_epoch": history["best_epoch"],
        "stop_reason": history["stop_reason"],
        "target_transform": target,
        "artifacts": hashes(output, RUN_FILES),
    }
    write_json(output / "manifest.json", manifest)
    return manifest


def load_run(directory):
    directory = Path(directory)
    manifest = verify(directory, "run", RUN_FILES)
    processor = TrainingPreprocessor.from_metadata(read_json(directory / "preprocessing.json"))
    checkpoint = torch.load(directory / "model.pt", map_location="cpu", weights_only=True)
    features = processor.metadata()["feature_names"]
    if (
        checkpoint.get("version") != 2
        or checkpoint["architecture"] != [len(features), 64, 32, 1]
        or features != checkpoint["feature_names"]
        or features != manifest["feature_names"]
        or manifest["dimension"] != len(features)
        or checkpoint["preprocessing_sha256"] != digest(directory / "preprocessing.json")
        or checkpoint["target_transform"] != manifest["target_transform"]
    ):
        raise ValueError("Incompatible model/preprocessing identity or dimension")
    target = checkpoint["target_transform"]
    if (
        target.get("version") != 1
        or not math.isfinite(target["mean"])
        or not math.isfinite(target["scale"])
        or target["scale"] <= 0
    ):
        raise ValueError("Invalid target transform")
    model = GasMLP(len(features))
    model.load_state_dict(checkpoint["state_dict"], strict=True)
    model.eval()
    baseline = SelectorMedian.from_metadata(read_json(directory / "baseline.json"))
    return model, processor, baseline, target, manifest


def predict_rows(directory, rows):
    model, processor, baseline, target, manifest = load_run(directory)
    predictions = predict(model, processor.transform(rows), target)
    medians, fallbacks = baseline.predict(rows)
    return {
        "pipeline_check_only": manifest["pipeline_check_only"],
        "mlp": predictions,
        "selector_median": medians,
        "baseline_fallback_count": fallbacks,
    }
