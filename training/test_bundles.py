import copy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import torch

from training.bundles import load_run, predict_rows, prepare, train_bundle
from training.fixtures import extraction
from training.prepare_dataset import digest, read_json, write_json
from training.preprocessing import TrainingPreprocessor
from training.trainer import TrainConfig


class BundleTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.source, self.prepared, self.run = [
            self.root / n for n in ("source", "prepared", "run")
        ]
        extraction(self.source)
        prepare(self.source, self.prepared, "smoke")
        self.config = TrainConfig(max_epochs=2)
        train_bundle(self.prepared, self.run, self.config)
        self.rows = read_json(self.prepared / "validation.json")

    def test_roundtrip_frozen_inference_cpu_weights_only_and_no_test_reads(self):
        x = TrainingPreprocessor.from_metadata(
            read_json(self.prepared / "preprocessing.json")
        ).transform(self.rows)
        with patch.object(
            TrainingPreprocessor, "fit", side_effect=AssertionError("Inference fitted")
        ):
            first = predict_rows(self.run, self.rows)
            model, processor, _, _, _ = load_run(self.run)
            torch.testing.assert_close(x, processor.transform(self.rows), rtol=0, atol=0)
            self.assertTrue(all(p.device.type == "cpu" for p in model.parameters()))
            self.assertEqual(first, predict_rows(self.run, self.rows))
        original = read_json

        def guarded(path):
            self.assertNotIn(Path(path).name, ("test.json", "unseen-contract.json"))
            return original(path)

        with patch("training.bundles.read_json", side_effect=guarded):
            train_bundle(self.prepared, self.root / "second", self.config)
        self.assertEqual(first, predict_rows(self.root / "second", self.rows))

    def test_existing_output_and_incomplete(self):
        with self.assertRaisesRegex(ValueError, "exists"):
            prepare(self.source, self.prepared, "smoke")
        with self.assertRaisesRegex(ValueError, "exists"):
            train_bundle(self.prepared, self.run, self.config)
        manifest = read_json(self.run / "manifest.json")
        manifest["complete"] = False
        write_json(self.run / "manifest.json", manifest)
        with self.assertRaisesRegex(ValueError, "Incomplete"):
            load_run(self.run)

    def test_corruption_missing_swapping_and_versions(self):
        m = read_json(self.run / "manifest.json")
        for changes in ({"version": 999}, {"dimension": 999}, {"feature_names": []}):
            altered = copy.deepcopy(m)
            altered.update(changes)
            write_json(self.run / "manifest.json", altered)
            with self.assertRaises(ValueError):
                load_run(self.run)
        write_json(self.run / "manifest.json", m)
        path = self.run / "preprocessing.json"
        original = path.read_bytes()
        path.write_text("corrupt")
        with self.assertRaisesRegex(ValueError, "integrity"):
            load_run(self.run)
        path.write_bytes(original)
        for mutation in (
            lambda p: p.update(version=999),
            lambda p: p["feature_names"].reverse(),
            lambda p: p["numeric"]["value"].update(mean=999),
        ):
            p = read_json(path)
            mutation(p)
            write_json(path, p)
            altered = copy.deepcopy(m)
            altered["artifacts"]["preprocessing.json"] = digest(path)
            write_json(self.run / "manifest.json", altered)
            with self.assertRaises(ValueError):
                load_run(self.run)
            path.write_bytes(original)
        write_json(self.run / "manifest.json", m)
        (self.run / "history.json").unlink()
        with self.assertRaisesRegex(ValueError, "integrity"):
            load_run(self.run)
