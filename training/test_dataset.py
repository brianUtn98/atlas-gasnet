"""Check train-only preprocessing, source alignment and usable PyTorch batches."""

import copy
import hashlib
import unittest

import torch
from torch import nn
from torch.utils.data import DataLoader

from training.dataset import DEFAULT_ROOT, GasDataset
from training.prepare_dataset import (
    SPLITS,
    STATE_NUMERIC,
    FeaturePreprocessor,
    read_json,
)


class PreprocessingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rows = read_json(DEFAULT_ROOT / "train.json")[:20]

    def test_unknown_categories_and_missing_state_do_not_refit_training(self):
        processor = FeaturePreprocessor().fit(self.rows)
        original = copy.deepcopy(processor.metadata())
        held_out = copy.deepcopy(self.rows[0])
        held_out["to"] = "0x" + "12" * 20
        held_out["value"] = str(2**255)
        for name in STATE_NUMERIC:
            held_out[name] = None
        payload = processor.transform([held_out], "test", "test-identity")
        self.assertEqual(processor.metadata(), original)
        self.assertEqual(payload["X"][0, processor.feature_names.index("to=<UNKNOWN>")].item(), 1)
        for name in STATE_NUMERIC:
            self.assertEqual(
                payload["X"][0, processor.feature_names.index(f"missing:{name}")].item(),
                1,
            )
        self.assertIsNone(held_out["tokenAmount"])
        self.assertTrue(torch.isfinite(payload["X"]).all())

    def test_targets_and_receipt_audit_fields_cannot_change_predictors(self):
        processor = FeaturePreprocessor().fit(self.rows)
        changed = copy.deepcopy(self.rows)
        for row in changed:
            row["gasUsed"] = str(int(row["gasUsed"]) + 500)
            row["receiptStatus"] = "reverted"
            row["blockTimestamp"] = "9999999999"
            row["stateEnrichmentStatus"] = "changed-audit-only"
            row["stateEnrichmentReason"] = "changed-audit-only"
        first = processor.transform(self.rows, "train", "test-identity")
        second = processor.transform(changed, "train", "test-identity")
        self.assertTrue(torch.equal(first["X"], second["X"]))
        self.assertFalse(torch.equal(first["y"], second["y"]))


class SnapshotTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest = read_json(DEFAULT_ROOT / "manifest.json")

    def test_artifact_integrity_and_training_only_fit(self):
        for name, artifact in self.manifest["artifacts"].items():
            raw = (DEFAULT_ROOT / name).read_bytes()
            self.assertEqual(hashlib.sha256(raw).hexdigest(), artifact["sha256"])
            self.assertEqual(len(raw), artifact["bytes"])
        fitted = FeaturePreprocessor().fit(read_json(DEFAULT_ROOT / "train.json"))
        self.assertEqual(fitted.metadata(), read_json(DEFAULT_ROOT / "preprocessing.json"))

    def test_all_rows_match_json_and_splits_are_disjoint(self):
        identities = set()
        processor = FeaturePreprocessor().fit(read_json(DEFAULT_ROOT / "train.json"))
        preprocessing_hash = self.manifest["artifacts"]["preprocessing.json"]["sha256"]
        for split in SPLITS:
            raw = read_json(DEFAULT_ROOT / f"{split}.json")
            dataset = GasDataset(split)
            baseline = GasDataset(split, baseline=True)
            rebuilt = processor.transform(raw, split, preprocessing_hash)
            self.assertEqual(len(dataset), self.manifest["splits"][split]["rows"])
            self.assertTrue(torch.equal(dataset.inputs, rebuilt["X"]))
            self.assertTrue(torch.equal(baseline.inputs, rebuilt["X_baseline"]))
            self.assertEqual(
                dataset.raw_gas_used.reshape(-1).tolist(),
                [int(row["gasUsed"]) for row in raw],
            )
            self.assertEqual(
                dataset.row_ids,
                [f"{row['chainId']}:{row['transactionHash']}" for row in raw],
            )
            self.assertFalse(identities.intersection(dataset.row_ids))
            identities.update(dataset.row_ids)
            if split == "unseen-contract":
                unknown = dataset.feature_names.index("to=<UNKNOWN>")
                self.assertTrue((dataset.inputs[:, unknown] == 1).all())
        self.assertEqual(len(identities), 15937)

    def test_dataloader_produces_a_valid_regression_backward_pass(self):
        torch.manual_seed(7)
        dataset = GasDataset("train")
        inputs, targets = next(iter(DataLoader(dataset, batch_size=64, shuffle=True)))
        model = nn.Sequential(nn.Linear(inputs.shape[1], 32), nn.ReLU(), nn.Linear(32, 1))
        predictions = model(inputs)
        self.assertEqual(predictions.shape, targets.shape)
        loss = nn.functional.mse_loss(predictions, targets)
        loss.backward()
        self.assertTrue(torch.isfinite(loss))
        self.assertTrue(
            all(torch.isfinite(parameter.grad).all() for parameter in model.parameters())
        )


if __name__ == "__main__":
    unittest.main()
