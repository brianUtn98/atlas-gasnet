"""Publish immutable raw JSON and training-fitted PyTorch dataset snapshots."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import shutil
import statistics
from collections import Counter
from datetime import UTC, datetime
from fractions import Fraction
from pathlib import Path

import torch

ROOT = Path(__file__).resolve().parents[1]
SPLITS = ("train", "validation", "test", "unseen-contract")
BASE_NUMERIC = {
    "calldataBytes": "identity",
    "calldataNonzeroBytes": "identity",
    "value": "log1p",
    "accessListStorageKeyCount": "log1p",
}
STATE_NUMERIC = {
    "tokenAmount": "log1p",
    "isZeroAmount": "identity",
    "isSelfTransfer": "identity",
    "senderHasEnoughBalance": "identity",
    "amountToSenderBalanceRatio": "log1p_fraction",
    "senderTokenBalanceBeforeBlock": "log1p",
    "recipientTokenBalanceBeforeBlock": "log1p",
    "recipientBalanceWasZero": "identity",
    "senderBalanceEqualsAmount": "identity",
}
CATEGORICAL = ("chainName", "to", "functionSelector")


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value) -> None:
    path.write_text(
        json.dumps(value, indent=2, allow_nan=False) + "\n",
        encoding="utf-8",
        newline="\n",
    )


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class FeaturePreprocessor:
    """Fit numeric statistics and categorical vocabulary on training inputs only."""

    @staticmethod
    def numeric(row: dict, field: str, transform: str) -> float | None:
        raw = row[field]
        if raw is None:
            if field in BASE_NUMERIC:
                raise ValueError(f"Required predictor missing: {field}")
            return None
        if transform == "log1p_fraction":
            numerator, denominator = str(raw).split("/")
            if not numerator.isdecimal() or not denominator.isdecimal() or int(denominator) <= 0:
                raise ValueError("Invalid rational predictor")
            value = math.log1p(Fraction(int(numerator), int(denominator)))
        else:
            if isinstance(raw, bool) or not str(raw).isdecimal():
                raise ValueError(f"Invalid nonnegative integer predictor: {field}")
            integer = int(raw)
            indicator = field.startswith("is") or field in (
                "senderHasEnoughBalance",
                "recipientBalanceWasZero",
                "senderBalanceEqualsAmount",
            )
            if indicator and integer not in (0, 1):
                raise ValueError(f"Invalid indicator: {field}")
            value = math.log1p(integer) if transform == "log1p" else float(integer)
        if not math.isfinite(value):
            raise ValueError(f"Non-finite predictor: {field}")
        return value

    def fit(self, training: list[dict]) -> FeaturePreprocessor:
        if not training:
            raise ValueError("Training split is empty")
        self.statistics = {}
        self.vocabularies = {
            field: sorted({row[field] for row in training}) for field in CATEGORICAL
        }
        for field, transform in (BASE_NUMERIC | STATE_NUMERIC).items():
            values = [self.numeric(row, field, transform) for row in training]
            present = [value for value in values if value is not None]
            if not present:
                raise ValueError(f"No training coverage for {field}")
            median = float(statistics.median(present))
            filled = [median if value is None else value for value in values]
            mean = math.fsum(filled) / len(filled)
            std = math.sqrt(math.fsum((value - mean) ** 2 for value in filled) / len(filled))
            self.statistics[field] = {
                "transform": transform,
                "median": median,
                "mean": mean,
                "std": std if std > 1e-12 else 1.0,
            }
        categorical_names = [
            f"{field}={category}"
            for field, values in self.vocabularies.items()
            for category in ["<UNKNOWN>", *values]
        ]
        self.feature_names = [
            *[f"standardized:{field}" for field in self.statistics],
            *[f"missing:{field}" for field in STATE_NUMERIC],
            *categorical_names,
        ]
        self.baseline_feature_names = [
            *[f"standardized:{field}" for field in BASE_NUMERIC],
            *categorical_names,
        ]
        self.baseline_indices = [
            self.feature_names.index(name) for name in self.baseline_feature_names
        ]
        self.training_rows = len(training)
        return self

    def metadata(self) -> dict:
        return {
            "version": 1,
            "fit_split": "train",
            "training_rows": self.training_rows,
            "numeric": self.statistics,
            "categorical": self.vocabularies,
            "unknown_category_index": 0,
            "feature_names": self.feature_names,
            "baseline_feature_names": self.baseline_feature_names,
            "baseline_indices": self.baseline_indices,
            "target": "gasUsed",
            "target_transform": "none",
            "state_reference": "end_of_previous_block",
            "missing_policy": "training_median_after_transform_plus_missing_indicator",
        }

    def transform(self, rows: list[dict], split: str, preprocessing_sha256: str) -> dict:
        vectors = []
        for row in rows:
            values = {}
            vector = []
            for field, fitted in self.statistics.items():
                value = self.numeric(row, field, fitted["transform"])
                values[field] = value
                filled = fitted["median"] if value is None else value
                vector.append((filled - fitted["mean"]) / fitted["std"])
            vector.extend(float(values[field] is None) for field in STATE_NUMERIC)
            for field, vocabulary in self.vocabularies.items():
                category = row[field]
                vector.extend(
                    [
                        float(category not in vocabulary),
                        *[float(category == v) for v in vocabulary],
                    ]
                )
            vectors.append(vector)
        inputs = torch.tensor(vectors, dtype=torch.float32)
        exact_targets = torch.tensor(
            [int(row["gasUsed"]) for row in rows], dtype=torch.int64
        ).reshape(-1, 1)
        if not torch.isfinite(inputs).all():
            raise ValueError("Non-finite model inputs")
        return {
            "version": 1,
            "split": split,
            "preprocessing_sha256": preprocessing_sha256,
            "X": inputs,
            "X_baseline": inputs[:, self.baseline_indices].contiguous(),
            "y": exact_targets.to(torch.float32),
            "gas_used": exact_targets,
            "row_ids": [f"{row['chainId']}:{row['transactionHash']}" for row in rows],
            "block_number": torch.tensor(
                [int(row["blockNumber"]) for row in rows], dtype=torch.int64
            ),
            "transaction_index": torch.tensor(
                [int(row["transactionIndex"]) for row in rows], dtype=torch.int64
            ),
            "feature_names": self.feature_names,
            "baseline_feature_names": self.baseline_feature_names,
        }


class DatasetSnapshotBuilder:
    def __init__(self, source: Path, destination: Path):
        self.source = source
        self.destination = destination

    def load_sources(self) -> tuple[dict, dict]:
        datasets, manifests, identities = {}, {}, set()
        previous_end = None
        known_contracts = None
        for split in SPLITS:
            manifest = read_json(self.source / split / "manifest.json")
            rows = read_json(self.source / split / "transactions.json")
            selection = manifest["selection"]
            start, end = int(selection["fromBlock"]), int(selection["toBlock"])
            if not manifest["complete"] or int(manifest["nextBlock"]) != end + 1:
                raise ValueError(f"Incomplete extraction: {split}")
            if manifest["schemaVersion"] != "3" or selection["network"] != "ETHEREUM":
                raise ValueError("Unexpected source schema/network")
            if len(rows) != manifest["rowCount"] or not rows:
                raise ValueError(f"Missing source rows: {split}")
            if rows != sorted(
                rows,
                key=lambda row: (int(row["blockNumber"]), int(row["transactionIndex"])),
            ):
                raise ValueError("Source rows must be chronologically ordered")
            if split != "unseen-contract":
                if previous_end is not None and previous_end + 1 != start:
                    raise ValueError("Temporal split ranges must be contiguous and disjoint")
                if known_contracts is not None and known_contracts != selection["contracts"]:
                    raise ValueError("Temporal split selections differ")
                known_contracts = selection["contracts"]
                previous_end = end
            else:
                if {c["address"] for c in known_contracts} & {
                    c["address"] for c in selection["contracts"]
                }:
                    raise ValueError("Unseen contract appears in training")
                test_range = manifests["test"]["selection"]
                if (str(start), str(end)) != (
                    test_range["fromBlock"],
                    test_range["toBlock"],
                ):
                    raise ValueError("Unseen-contract test must use the temporal test window")
            for row in rows:
                identity = f"{row['chainId']}:{row['transactionHash']}"
                if identity in identities:
                    raise ValueError("Duplicate transaction across splits")
                identities.add(identity)
                if (
                    row["schemaVersion"] != "3"
                    or row["chainId"] != "1"
                    or not start <= int(row["blockNumber"]) <= end
                ):
                    raise ValueError("Row outside source selection")
                if not str(row["gasUsed"]).isdecimal() or int(row["gasUsed"]) >= 2**63:
                    raise ValueError("Invalid target")
            # Verify original part bytes against the extraction's immutable hashes.
            for part in manifest["parts"]:
                if digest(self.source / split / part["file"]) != part["sha256"]:
                    raise ValueError("Source part integrity check failed")
            datasets[split], manifests[split] = rows, manifest
        return datasets, manifests

    def build(self) -> dict:
        if (self.destination / "manifest.json").exists():
            raise ValueError("Snapshot already exists; choose a new --output directory")
        datasets, manifests = self.load_sources()
        self.destination.mkdir(parents=True, exist_ok=True)
        provenance = self.destination / "provenance"
        provenance.mkdir(exist_ok=True)
        processor = FeaturePreprocessor().fit(datasets["train"])
        write_json(self.destination / "preprocessing.json", processor.metadata())
        preprocessing_hash = digest(self.destination / "preprocessing.json")
        summaries = {}
        artifacts = ["preprocessing.json"]
        for split, rows in datasets.items():
            shutil.copyfile(
                self.source / split / "transactions.json",
                self.destination / f"{split}.json",
            )
            shutil.copyfile(
                self.source / split / "manifest.json",
                provenance / f"{split}.manifest.json",
            )
            payload = processor.transform(rows, split, preprocessing_hash)
            torch.save(payload, self.destination / f"{split}.pt")
            roundtrip = torch.load(
                self.destination / f"{split}.pt", map_location="cpu", weights_only=True
            )
            if not torch.equal(roundtrip["X"], payload["X"]) or not torch.equal(
                roundtrip["gas_used"], payload["gas_used"]
            ):
                raise ValueError("Tensor serialization round trip failed")
            manifest = manifests[split]
            summaries[split] = {
                "rows": len(rows),
                "fromBlock": manifest["selection"]["fromBlock"],
                "toBlock": manifest["selection"]["toBlock"],
                "selection_fingerprint": manifest["fingerprint"],
                "X_shape": list(payload["X"].shape),
                "X_baseline_shape": list(payload["X_baseline"].shape),
                "enrichment_status": dict(Counter(row["stateEnrichmentStatus"] for row in rows)),
                "enrichment_failure_reasons": dict(
                    Counter(
                        row["stateEnrichmentReason"]
                        for row in rows
                        if row["stateEnrichmentStatus"] == "failed"
                    )
                ),
                "contract_function_counts": dict(
                    Counter(f"{row['to']}:{row['functionSelector']}" for row in rows)
                ),
            }
            artifacts.extend([f"{split}.json", f"{split}.pt", f"provenance/{split}.manifest.json"])
        result = {
            "dataset_id": "ethereum-poc-v1",
            "version": 1,
            "created_utc": datetime.now(UTC).isoformat(),
            "source_schema_version": "3",
            "torch_version": str(torch.__version__),
            "total_distinct_rows": sum(len(rows) for rows in datasets.values()),
            "preprocessing_fit_split": "train",
            "target": "gasUsed",
            "splits": summaries,
            "artifacts": {
                name: {
                    "sha256": digest(self.destination / name),
                    "bytes": (self.destination / name).stat().st_size,
                }
                for name in artifacts
            },
        }
        write_json(self.destination / "manifest.json", result)
        return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=ROOT / "data/extractions/poc-v3")
    parser.add_argument("--output", type=Path, default=ROOT / "data/poc/v1")
    args = parser.parse_args()
    result = DatasetSnapshotBuilder(args.source, args.output).build()
    for split, details in result["splits"].items():
        print(
            f"{split}: {details['rows']} rows, X={details['X_shape']}, baseline={details['X_baseline_shape']}"
        )
    print(f"Published {result['total_distinct_rows']} distinct rows to {args.output}")


if __name__ == "__main__":
    main()
