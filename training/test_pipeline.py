"""End-to-end tests generated entirely in temporary directories, without RPC."""

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from training.baseline import SelectorMedian
from training.bundles import predict_rows, prepare, train_bundle
from training.evaluation import evaluate
from training.fixtures import extraction, poc_extraction, row
from training.prepare_dataset import read_json
from training.preprocessing import TrainingPreprocessor
from training.sources import identity
from training.trainer import TrainConfig


class PipelineTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)

    def test_primary_prepare_train_reload_evaluate_offline(self):
        source, prepared, run = [self.root / n for n in ("poc", "prepared", "run")]
        poc_extraction(source)
        with patch("socket.create_connection", side_effect=AssertionError("Network access")):
            prepare(source, prepared)
            train_bundle(prepared, run, TrainConfig(max_epochs=3, batch_size=3))
            rows = read_json(prepared / "unseen-contract.json")
            with (
                patch.object(TrainingPreprocessor, "fit", side_effect=AssertionError("refit")),
                patch.object(SelectorMedian, "fit", side_effect=AssertionError("refit")),
            ):
                predicted = predict_rows(run, rows)
                result = evaluate(run, prepared)
                self.assertTrue(evaluate(run, prepared, verification=True)["verification_only"])
        self.assertFalse(result["pipeline_check_only"])
        self.assertEqual(set(result["final_tests"]), {"test", "unseen-contract"})
        self.assertEqual(len(predicted["mlp"]), 2)
        self.assertTrue((run / "evaluation/unseen-contract.png").is_file())
        self.assertEqual(
            result["final_tests"]["unseen-contract"]["estimators"]["mlp"]["aggregate"]["count"], 2
        )

    def test_smoke_rounding_uneven_rows_and_empty_blocks(self):
        source, prepared = self.root / "source", self.root / "prepared"
        extraction(
            source,
            [row(100), *[row(101, i) for i in range(5)], *[row(102, i) for i in range(5)]],
            start=100,
            end=102,
        )
        prepare(source, prepared, "smoke")
        provenance = read_json(prepared / "provenance.json")
        self.assertEqual([s["rows"] for s in provenance["splits"].values()], [1, 5, 5])
        self.assertTrue(all(s["block_fraction"] == 1 / 3 for s in provenance["splits"].values()))
        self.assertTrue(provenance["pipeline_check_only"])
        sparse = self.root / "sparse"
        extraction(sparse, [row(100), row(108), row(109)], start=100, end=109)
        with self.assertRaisesRegex(ValueError, "empty"):
            prepare(sparse, self.root / "bad", "smoke")
        self.assertFalse((self.root / "bad").exists())

    def test_cli_commands(self):
        source = self.root / "source"
        extraction(source)

        def cli(*args):
            subprocess.run(
                [sys.executable, "-m", "training.pipeline", *map(str, args)],
                check=True,
                capture_output=True,
                text=True,
                env=os.environ.copy(),
            )

        prepared, run = self.root / "prepared", self.root / "run"
        cli("prepare", "--mode", "smoke", "--source", source, "--output", prepared)
        cli("train", "--prepared", prepared, "--output", run, "--max-epochs", 2)
        cli(
            "predict",
            "--run",
            run,
            "--input",
            prepared / "validation.json",
            "--output",
            self.root / "predictions.json",
        )
        cli("evaluate", "--run", run, "--prepared", prepared)
        cli("evaluate", "--run", run, "--prepared", prepared, "--verify")
        cli("smoke", "--source", source, "--output", self.root / "smoke")
        self.assertTrue(
            read_json(self.root / "smoke/run/evaluation/metrics.json")["pipeline_check_only"]
        )

    def test_cross_partition_identity_rejected(self):
        source = self.root / "poc"
        poc_extraction(source)
        from training.prepare_dataset import SPLITS
        from training.sources import load_extraction
        from training.splits import validate_poc

        loaded = {s: load_extraction(source / s) for s in SPLITS}
        datasets = {s: pair[0] for s, pair in loaded.items()}
        datasets["test"][0]["transactionHash"] = datasets["train"][0]["transactionHash"]
        self.assertEqual(identity(datasets["train"][0]), identity(datasets["test"][0]))
        with self.assertRaisesRegex(ValueError, "overlaps"):
            validate_poc(
                {s: pair[1]["manifest"]["selection"] for s, pair in loaded.items()}, datasets
            )
