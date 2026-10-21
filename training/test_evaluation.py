import math
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pandas as pd

from training.baseline import SelectorMedian
from training.bundles import prepare, train_bundle
from training.evaluation import evaluate, metrics, summarize
from training.fixtures import extraction, row
from training.prepare_dataset import read_json
from training.preprocessing import TrainingPreprocessor
from training.trainer import TrainConfig


class MetricTests(unittest.TestCase):
    def test_hand_calculated_and_undefined(self):
        m = metrics([1, 2, 3], [2, 2, 5])
        self.assertEqual(m["mae"], 1)
        self.assertEqual(m["rmse"], math.sqrt(5 / 3))
        self.assertEqual(m["r2"], -1.5)
        for y, reason in (([1], "fewer_than_two_rows"), ([2, 2], "constant_target")):
            m = metrics(y, y)
            self.assertIsNone(m["r2"])
            self.assertEqual(m["r2_undefined_reason"], reason)
        for y, p in (([], []), ([1], [float("nan")]), ([1], []), ([float("inf")], [1])):
            with self.assertRaises(ValueError):
                metrics(y, p)
        groups = summarize([row(to="unknown", functionSelector=None)], [3], [4])
        self.assertEqual(groups["to"]["unknown"]["count"], 1)
        self.assertTrue(groups["functionSelector"]["<NULL>"]["rare_group"])


class EvaluationTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        extraction(self.root / "source")
        self.prepared, self.run = self.root / "prepared", self.root / "run"
        prepare(self.root / "source", self.prepared, "smoke")
        train_bundle(self.prepared, self.run, TrainConfig(max_epochs=2))

    def test_aligned_frozen_evaluation_and_verification(self):
        with (
            patch.object(TrainingPreprocessor, "fit", side_effect=AssertionError("refit")),
            patch.object(SelectorMedian, "fit", side_effect=AssertionError("refit")),
        ):
            report = evaluate(self.run, self.prepared)
            self.assertTrue(
                evaluate(self.run, self.prepared, verification=True)["verification_only"]
            )
        self.assertTrue(report["pipeline_check_only"])
        self.assertEqual(set(report["final_tests"]), {"test"})
        frame = pd.read_csv(self.run / "evaluation/test.csv")
        self.assertEqual(len(frame), 3)
        np.testing.assert_allclose(
            frame.actual_gasUsed - frame.mlp_prediction, frame.mlp_residual, rtol=0, atol=1e-9
        )
        self.assertEqual(len(frame.mlp_prediction), len(frame.selector_median_prediction))
        with self.assertRaisesRegex(ValueError, "already exists"):
            evaluate(self.run, self.prepared)
        (self.run / "evaluation/metrics.json").write_text("corrupt")
        with self.assertRaisesRegex(ValueError, "integrity"):
            evaluate(self.run, self.prepared, verification=True)

    def test_fingerprint_fails_before_final_labels(self):
        (self.prepared / "manifest.json").write_text(
            (self.prepared / "manifest.json").read_text() + "\n"
        )
        original = read_json

        def guarded(path):
            self.assertNotEqual(Path(path).name, "test.json")
            return original(path)

        with (
            patch("training.evaluation.read_json", side_effect=guarded),
            self.assertRaisesRegex(ValueError, "fingerprint"),
        ):
            evaluate(self.run, self.prepared)
        with self.assertRaisesRegex(ValueError, "No existing"):
            evaluate(self.run, self.prepared, verification=True)
