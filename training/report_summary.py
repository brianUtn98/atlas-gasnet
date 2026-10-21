"""Read the selected run and its evaluation for the academic report."""

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd

from training.bundles import load_run
from training.evaluation import metrics, summarize
from training.trainer import predict


def summary(run, prepared):
    model, processor, baseline, target, manifest = load_run(run)
    history = json.loads((run / "history.json").read_text())
    report = json.loads((run / "evaluation/metrics.json").read_text())
    result = {
        "history": {
            "epochs": len(history["epochs"]),
            "best_epoch": history["best_epoch"],
            "first": history["epochs"][0],
            "best": history["epochs"][history["best_epoch"] - 1],
            "last": history["epochs"][-1],
        },
        "target": target,
        "final_tests": {
            split: {name: data["aggregate"] for name, data in section["estimators"].items()}
            for split, section in report["final_tests"].items()
        },
    }
    for split in ("train", "validation"):
        rows = json.loads((prepared / f"{split}.json").read_text())
        y = np.array([int(row["gasUsed"]) for row in rows], dtype=float)
        p = np.array(predict(model, processor.transform(rows), target))
        medians, fallbacks = baseline.predict(rows)
        error = np.abs(y - p)
        result[split] = {
            "mlp": metrics(y, p),
            "median": metrics(y, medians),
            "groups_mlp": summarize(rows, y, p),
            "abs_error_quantiles": np.quantile(error, [0.5, 0.9, 1]).tolist(),
            "mean_bias": float(np.mean(p - y)),
            "within_10pct": float(np.mean(error / y <= 0.1)),
            "within_20pct": float(np.mean(error / y <= 0.2)),
            "negative_predictions": int(np.sum(p < 0)),
            "fallbacks": fallbacks,
        }
    frame = pd.read_csv(run / "evaluation/validation.csv")
    frame["absolute_error"] = frame["mlp_residual"].abs()
    examples = []
    for selector in ("0x095ea7b3", "0x23b872dd"):
        subset = frame[frame["functionSelector"] == selector]
        examples.append(subset.loc[subset["absolute_error"].idxmax()].to_dict())
    examples.append(frame.loc[frame["absolute_error"].idxmin()].to_dict())
    result["examples"] = examples
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--prepared", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = summary(args.run, args.prepared)
    args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
