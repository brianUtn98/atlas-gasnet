"""Offline prepare/train/predict/evaluate command-line entry points."""

import argparse
from pathlib import Path

from training.bundles import predict_rows, prepare, train_bundle
from training.prepare_dataset import ROOT, read_json, write_json
from training.trainer import TrainConfig


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    p = commands.add_parser("prepare")
    p.add_argument("--mode", choices=["poc", "smoke"], default="poc")
    p.add_argument("--source", type=Path)
    p.add_argument("--output", type=Path, required=True)
    p = commands.add_parser("train")
    p.add_argument("--prepared", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--learning-rate", type=float, default=0.001)
    p.add_argument("--batch-size", type=int, default=64)
    p.add_argument("--max-epochs", type=int, default=500)
    p.add_argument("--patience", type=int, default=25)
    p.add_argument("--min-delta", type=float, default=1e-6)
    p.add_argument("--device", choices=["cpu", "cuda"], default="cpu")
    p = commands.add_parser("predict")
    p.add_argument("--run", type=Path, required=True)
    p.add_argument("--input", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    p = commands.add_parser("evaluate")
    p.add_argument("--run", type=Path, required=True)
    p.add_argument("--prepared", type=Path, required=True)
    p.add_argument(
        "--verify", action="store_true", help="Repeat unchanged evaluation without overwriting"
    )
    p = commands.add_parser("smoke")
    p.add_argument("--source", type=Path, default=ROOT / "data/extractions/usdc-enriched-v3")
    p.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "prepare":
        source = args.source or ROOT / "data/extractions" / (
            "poc-v3" if args.mode == "poc" else "usdc-enriched-v3"
        )
        result = prepare(source, args.output, args.mode)
        print({s: len(read_json(args.output / f"{s}.json")) for s in result["splits"]})
        print({"pipeline_check_only": result["pipeline_check_only"]})
    elif args.command == "train":
        config = TrainConfig(
            **{
                k: getattr(args, k)
                for k in (
                    "seed",
                    "learning_rate",
                    "batch_size",
                    "max_epochs",
                    "patience",
                    "min_delta",
                    "device",
                )
            }
        )
        train_bundle(args.prepared, args.output, config)
        print(f"Selected run saved: {args.output}")
    elif args.command == "predict":
        if args.output.exists():
            raise ValueError("Output already exists")
        write_json(args.output, predict_rows(args.run, read_json(args.input)))
    elif args.command == "evaluate":
        from training.evaluation import evaluate

        evaluate(args.run, args.prepared, verification=args.verify)
        print(f"Evaluation {'verified' if args.verify else 'saved'}: {args.run / 'evaluation'}")
    else:
        from training.evaluation import evaluate

        if args.output.exists():
            raise ValueError("Output already exists")
        prepare(args.source, args.output / "prepared", "smoke")
        train_bundle(args.output / "prepared", args.output / "run", TrainConfig(max_epochs=10))
        evaluate(args.output / "run", args.output / "prepared")
        print({"pipeline_check_only": True, "output": str(args.output)})


if __name__ == "__main__":
    main()
