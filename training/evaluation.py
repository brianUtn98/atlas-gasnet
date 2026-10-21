"""Explicit post-selection evaluation; never fits or tunes an estimator."""

from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.metrics import mean_absolute_error, r2_score, root_mean_squared_error

from training.baseline import labels
from training.bundles import hashes, load_prepared, load_run, verify
from training.prepare_dataset import digest, read_json, write_json
from training.sources import fingerprint, identity
from training.trainer import predict


def metrics(actual, predicted):
    y, p = np.asarray(actual, dtype=np.float64), np.asarray(predicted, dtype=np.float64)
    if y.ndim != 1 or y.shape != p.shape or not len(y):
        raise ValueError("Empty or misaligned evaluation inputs")
    if not np.isfinite(y).all() or not np.isfinite(p).all():
        raise ValueError("Nonfinite evaluation inputs")
    reason = (
        "fewer_than_two_rows" if len(y) < 2 else "constant_target" if np.all(y == y[0]) else None
    )
    return {
        "count": len(y),
        "mae": float(mean_absolute_error(y, p)),
        "rmse": float(root_mean_squared_error(y, p)),
        "r2": None if reason else float(r2_score(y, p)),
        "r2_undefined_reason": reason,
    }


def summarize(rows, actual, predictions):
    result = {"aggregate": metrics(actual, predictions)}
    for field in ("to", "functionSelector"):
        groups = {}
        for i, row in enumerate(rows):
            groups.setdefault(row[field], []).append(i)
        result[field] = {
            str(key) if key is not None else "<NULL>": {
                **metrics([actual[i] for i in indices], [predictions[i] for i in indices]),
                "rare_group": len(indices) < 10,
                "limitation": "support_below_10" if len(indices) < 10 else None,
            }
            for key, indices in groups.items()
        }
    return result


def plot_comparison(actual, predictions, output, split, smoke):
    import matplotlib

    matplotlib.use("Agg")
    from matplotlib import pyplot as plt

    fig, axes = plt.subplots(1, 2, figsize=(10, 4), layout="constrained")
    for axis, (name, predicted) in zip(axes, predictions.items(), strict=True):
        low = min(min(actual), min(predicted))
        high = max(max(actual), max(predicted))
        if low == high:
            low, high = low - 1, high + 1
        axis.scatter(actual, predicted, s=10, alpha=0.6)
        axis.plot([low, high], [low, high], color="black", linewidth=0.8)
        axis.set(xlabel="Actual gasUsed (gas)", ylabel="Predicted gasUsed (gas)", title=name)
    fig.suptitle(f"{split}" + (" — pipeline_check_only=true" if smoke else ""))
    fig.savefig(output, dpi=120, metadata={"Software": "Atlas GasNet"})
    plt.close(fig)


def evaluate(run, prepared, verification=False):
    run, prepared = Path(run), Path(prepared)
    destination = run / "evaluation"
    if destination.exists() and not verification:
        raise ValueError("Evaluation already exists; use --verify for unchanged verification")
    if verification and not destination.exists():
        raise ValueError("No existing evaluation to verify")
    model, processor, baseline, target, manifest = load_run(run)
    source = load_prepared(prepared)
    if manifest["prepared_manifest_sha256"] != digest(prepared / "manifest.json"):
        raise ValueError("Model/data fingerprint mismatch")
    binding = {
        "run_manifest_sha256": digest(run / "manifest.json"),
        "prepared_manifest_sha256": digest(prepared / "manifest.json"),
    }
    if verification:
        previous = verify(destination, "evaluation")
        if previous["binding"] != binding:
            raise ValueError("Evaluation fingerprint mismatch")
    report = {
        "version": 2,
        "pipeline_check_only": manifest["pipeline_check_only"],
        "binding": binding,
        "rare_group_threshold": 10,
        "validation_diagnostics": {},
        "final_tests": {},
    }
    frames, plot_data = {}, {}
    # No train labels needed; final labels are deserialized only after fingerprint verification.
    for split in (s for s in source["splits"] if s != "train"):
        rows = read_json(prepared / f"{split}.json")
        actual = labels(rows)
        predictions = {
            "mlp": predict(model, processor.transform(rows), target),
            "selector_median": baseline.predict(rows)[0],
        }
        section = {
            "estimators": {name: summarize(rows, actual, p) for name, p in predictions.items()},
            "baseline_fallback_count": baseline.predict(rows)[1],
            "row_ids_sha256": fingerprint([identity(r) for r in rows]),
        }
        if split == "validation":
            report["validation_diagnostics"] = section
        else:
            report["final_tests"][split] = section
        frames[split] = pd.DataFrame(
            {
                "row_id": [identity(r) for r in rows],
                "contract": [r["to"] for r in rows],
                "functionSelector": [r["functionSelector"] for r in rows],
                "actual_gasUsed": actual,
                "pipeline_check_only": manifest["pipeline_check_only"],
                **{f"{name}_prediction": p for name, p in predictions.items()},
                **{
                    f"{name}_residual": np.array(actual, dtype=float) - p
                    for name, p in predictions.items()
                },
            }
        )
        plot_data[split] = (actual, predictions)
    result_fingerprint = fingerprint(
        {"report": report, "tables": {s: f.to_dict("list") for s, f in frames.items()}}
    )
    if verification:
        if previous["result_sha256"] != result_fingerprint:
            raise ValueError("Repeated evaluation differs")
        return {
            "verification_only": True,
            "pipeline_check_only": manifest["pipeline_check_only"],
            "result_sha256": result_fingerprint,
        }
    destination.mkdir(exist_ok=False)
    write_json(destination / "metrics.json", report)
    artifacts = {"metrics.json"}
    for split, frame in frames.items():
        frame.to_csv(destination / f"{split}.csv", index=False, lineterminator="\n")
        actual, predictions = plot_data[split]
        plot_comparison(
            actual,
            predictions,
            destination / f"{split}.png",
            split,
            manifest["pipeline_check_only"],
        )
        artifacts |= {f"{split}.csv", f"{split}.png"}
    write_json(
        destination / "manifest.json",
        {
            "version": 2,
            "kind": "evaluation",
            "complete": True,
            "binding": binding,
            "pipeline_check_only": manifest["pipeline_check_only"],
            "result_sha256": result_fingerprint,
            "artifacts": hashes(destination, artifacts),
        },
    )
    return report
