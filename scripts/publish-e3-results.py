"""Export a completed, frozen E3 run without fitting or changing any estimator."""

import argparse
import json
import shutil
import sys
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

import matplotlib
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def publish(run, prepared, output):
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    from training.bundles import load_prepared, load_run, verify
    from training.prepare_dataset import digest, read_json, write_json

    run, prepared, output = Path(run), Path(prepared), Path(output)
    if output.exists():
        raise ValueError("Output already exists")
    *_, manifest = load_run(run)
    load_prepared(prepared)
    freeze = read_json(run / "model-freeze.json")
    binding = {
        "run_manifest_sha256": digest(run / "manifest.json"),
        "prepared_manifest_sha256": digest(prepared / "manifest.json"),
    }
    if (
        freeze["binding"] != binding
        or freeze["final_scores_consulted"] is not False
        or manifest["estimators"] != ["mlp", "selector_median", "symbolic"]
        or manifest["pipeline_check_only"] is not False
    ):
        raise ValueError("Expected a frozen, complete three-estimator experiment")
    for name in ("validation", "evaluation"):
        if verify(run / name, "evaluation")["binding"] != binding:
            raise ValueError("Evaluation binding differs from frozen run")
    report = read_json(run / "evaluation/metrics.json")
    history = read_json(run / "history.json")
    symbolic = read_json(run / "symbolic-history.json")
    provenance = read_json(run / "provenance.json")
    if provenance["mode"] != "e3":
        raise ValueError("Expected E3 provenance")
    config = read_json(run / "config.json")
    records = []
    diagnostics = {}
    sections = {"validation": report["validation_diagnostics"], **report["final_tests"]}
    for split, section in sections.items():
        table = pd.read_csv(run / "evaluation" / f"{split}.csv")
        diagnostics[split] = {}
        for estimator, summary in section["estimators"].items():
            predicted = table[f"{estimator}_prediction"]
            residual = table[f"{estimator}_residual"].abs()
            records.append({"split": split, "estimator": estimator, **summary["aggregate"]})
            diagnostics[split][estimator] = {
                "negative_predictions": int((predicted < 0).sum()),
                "absolute_error_p50_gas": float(residual.quantile(0.5)),
                "absolute_error_p95_gas": float(residual.quantile(0.95)),
                "absolute_error_max_gas": float(residual.max()),
            }
    output.mkdir(parents=True)
    for source in (run / "evaluation/metrics.json", run / "model-freeze.json"):
        shutil.copy2(source, output / source.name)
    for split in sections:
        shutil.copy2(run / "evaluation" / f"{split}.png", output / f"{split}.png")
    fig, ax = plt.subplots(figsize=(8, 4.5), layout="constrained")
    for field in ("train", "validation"):
        ax.plot(
            [e["epoch"] for e in history["epochs"]],
            [e[field] for e in history["epochs"]],
            label=field,
        )
    ax.axvline(history["best_epoch"], color="black", linestyle="--", label="selected epoch")
    ax.set(xlabel="Epoch", ylabel="Sample-weighted normalized MSE", title="E3 MLP learning curves")
    ax.legend()
    fig.savefig(output / "mlp-learning.png", dpi=150)
    plt.close(fig)
    fig, ax = plt.subplots(figsize=(8, 4.5), layout="constrained")
    for candidate in symbolic["candidates"]:
        details = candidate["generations"]
        ax.plot(
            details["generation"],
            details["best_fitness"],
            label=f"candidate {candidate['candidate']}",
        )
    ax.set(
        xlabel="Generation (zero-based)",
        ylabel="Best normalized training MAE",
        title="E3 symbolic training fitness",
    )
    ax.legend()
    fig.savefig(output / "symbolic-learning.png", dpi=150)
    plt.close(fig)
    archive = output / "selected-run.zip"
    with ZipFile(archive, "w", compression=ZIP_DEFLATED) as bundle:
        for path in sorted(run.rglob("*")):
            if path.is_file():
                bundle.write(path, str(Path("run") / path.relative_to(run)))
    summary = {
        "experiment": "E3",
        "execution": "local CPU",
        "binding": binding,
        "code_revision": config["runtime"]["code_revision"],
        "split_rows": {s: v["rows"] for s, v in provenance["splits"].items()},
        "feature_count": manifest["dimension"],
        "mlp_epochs": len(history["epochs"]),
        "mlp_selected_epoch": history["best_epoch"],
        "mlp_stop_reason": history["stop_reason"],
        "symbolic_selected_candidate": symbolic["selected_candidate"],
        "symbolic_candidates": symbolic["candidates"],
        "symbolic_expression_display_only": read_json(run / "symbolic.json")[
            "expression_display_only"
        ],
        "metrics": records,
        "prediction_diagnostics": diagnostics,
        "archive_sha256": digest(archive),
        "final_evaluation_result_sha256": verify(run / "evaluation", "evaluation")["result_sha256"],
    }
    write_json(output / "summary.json", summary)
    lines = [
        "# E3: retained MLP, Genetic Programming and baseline experiment",
        "",
        f"Executed on local CPU. Training code revision: `{summary['code_revision']}`.",
        f"This run uses all {summary['split_rows']['train']:,} training rows and the same {summary['feature_count']} frozen features for both learned models.",
        "Preprocessing, target transforms and baseline medians fit training only.",
        "",
        f"MLP ran {len(history['epochs'])} epochs, restored epoch {history['best_epoch']}, and stopped by `{history['stop_reason']}`.",
        f"Symbolic candidate {symbolic['selected_candidate']} won by validation gas-unit MAE.",
        "MLP epoch selection uses validation normalized MSE; the common comparison below uses gas-unit metrics.",
        "All estimators were frozen before either final-test score was consulted; see `model-freeze.json`.",
        "",
        "| Partition | Estimator | Rows | MAE (gas) | RMSE (gas) | R² |",
        "| --- | --- | ---: | ---: | ---: | ---: |",
    ]
    for record in records:
        lines.append(
            f"| {record['split']} | {record['estimator']} | {record['count']:,} | {record['mae']:,.2f} | {record['rmse']:,.2f} | {record['r2']:.4f} |"
        )
    lines += ["", "## Observed comparison", ""]
    for split in sections:
        winner = min((r for r in records if r["split"] == split), key=lambda r: r["mae"])
        lines.append(f"- Lowest {split} MAE: `{winner['estimator']}` ({winner['mae']:,.2f} gas).")
    lines += [
        "",
        "MLP led validation and temporal MAE, while symbolic led USDT MAE and RMSE in this frozen run.",
        "MLP USDT MAE was slightly above the selector baseline despite lower RMSE.",
        "This is evidence of a contract-shift limitation in the selected MLP, not a general ranking of model families.",
        "No model was changed or selected using final-test scores.",
        "",
        "Selected symbolic expression (display only; exact constants are stored in the JSON tree):",
        "",
        "```text",
        summary["symbolic_expression_display_only"],
        "```",
    ]
    lines += [
        "",
        "## Evidence and reproduction",
        "",
        "`metrics.json` retains aggregate and contract/function metrics with row-identity bindings.",
        "`summary.json` retains candidate choices, error quantiles, negative-prediction counts and artifact hashes.",
        "`selected-run.zip` contains portable weights/formula, preprocessing, baseline, full history, provenance,",
        "hash manifests, validation/final predictions and plots. It contains no original extraction data or credentials.",
        f"Archive SHA-256: `{summary['archive_sha256']}`.",
        "",
        "Extract the archive and use `training.bundles.load_run` or `predict_rows` on its `run/` directory.",
        "Verification against the original prepared inputs uses:",
        "",
        "```sh",
        "python -m training.pipeline evaluate --run run --prepared models/e3-prepared --verify",
        "```",
        "",
        "The original E3 manifests and listed Parquet parts are still required to reproduce fitting;",
        "the published E2 archive does not contain E3. See [the E3 guide](../../docs/e3-experiment.md).",
        "",
        "## Limits",
        "",
        "This is one fixed-seed experiment over a short Ethereum period, USDC/WETH9 training contracts",
        "and one unseen USDT contract. The limited symbolic search is not evidence that every GP model",
        "would perform similarly. Token base units differ across contracts; prior-block balances approximate",
        "pre-transaction state, and enrichment is supported only for canonical transfers.",
        "Predictions were neither clipped nor rounded. Final-test errors describe frozen models and cannot",
        "guide further E3 tuning. E2 used different observations, so E2/E3 scores are not a controlled ablation.",
        "",
    ]
    (output / "README.md").write_text("\n".join(lines), encoding="utf-8")
    print(
        json.dumps(
            {"output": str(output), "archive_bytes": archive.stat().st_size, "metrics": records},
            indent=2,
        )
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--prepared", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    publish(args.run, args.prepared, args.output)
