"""Version-2 predictor contract; legacy snapshot preprocessing remains unchanged."""

import copy
import math
import statistics
from fractions import Fraction

import torch

from training.prepare_dataset import BASE_NUMERIC, CATEGORICAL, STATE_NUMERIC
from training.sources import fingerprint, identity, unsigned

NUMERIC = BASE_NUMERIC | STATE_NUMERIC
FLAGS = {n for n, t in STATE_NUMERIC.items() if t == "identity"}
UNITS = {n: "indicator" if n in FLAGS else "count" for n in NUMERIC}
UNITS.update(
    value="wei",
    tokenAmount="token_base_units",
    senderTokenBalanceBeforeBlock="token_base_units",
    recipientTokenBalanceBeforeBlock="token_base_units",
    amountToSenderBalanceRatio="dimensionless",
)


def numeric(row, field):
    raw = row[field]
    if raw is None:
        if field in BASE_NUMERIC:
            raise ValueError(f"Required predictor missing: {field}")
        return None
    transform = NUMERIC[field]
    if transform == "log1p_fraction":
        parts = str(raw).split("/")
        if len(parts) != 2:
            raise ValueError(f"Invalid rational: {field}")
        n, d = [unsigned(p, field) for p in parts]
        if not d or math.gcd(n, d) != 1:
            raise ValueError(f"Invalid reduced rational: {field}")
        result = math.log1p(Fraction(n, d))
    else:
        maximum = (
            1
            if field in FLAGS
            else 2**31 - 1
            if field in BASE_NUMERIC and field != "value"
            else 2**256 - 1
        )
        value = unsigned(raw, field, maximum)
        result = math.log1p(value) if transform == "log1p" else float(value)
    if not math.isfinite(result):
        raise ValueError(f"Nonfinite predictor: {field}")
    return result


def validate_state(row):
    """Audit consistency at preparation, never include audit fields in X."""
    for field in NUMERIC:
        numeric(row, field)
    status, reason = row["stateEnrichmentStatus"], row["stateEnrichmentReason"]
    ref = row["stateBlockNumber"]
    if ref is not None and unsigned(ref, "stateBlockNumber") != int(row["blockNumber"]) - 1:
        raise ValueError("Invalid previous-block reference")
    calldata = ("tokenAmount", "isZeroAmount", "isSelfTransfer")
    history = set(STATE_NUMERIC) - set(calldata)
    if status == "complete":
        required = set(STATE_NUMERIC) - {"amountToSenderBalanceRatio"}
        if reason is not None or ref is None or any(row[f] is None for f in required):
            raise ValueError("Contradictory complete state")
        amount = int(row["tokenAmount"])
        sender = int(row["senderTokenBalanceBeforeBlock"])
        recipient = int(row["recipientTokenBalanceBeforeBlock"])
        ratio = None if sender == 0 else str(Fraction(amount, sender))
        # Fraction encodes integer quotients without /1; schema-3 always includes it.
        if sender:
            fraction = Fraction(amount, sender)
            ratio = f"{fraction.numerator}/{fraction.denominator}"
        expected = {
            "isZeroAmount": int(amount == 0),
            "senderHasEnoughBalance": int(sender >= amount),
            "recipientBalanceWasZero": int(recipient == 0),
            "senderBalanceEqualsAmount": int(sender == amount),
            "amountToSenderBalanceRatio": ratio,
        }
        if any(row[f] != v for f, v in expected.items()):
            raise ValueError("Contradictory balance indicators/ratio")
    elif status == "not_applicable":
        if (
            ref is not None
            or any(row[f] is not None for f in STATE_NUMERIC)
            or reason not in ("disabled", "contract_not_enabled", "other_function")
        ):
            raise ValueError("Contradictory not-applicable state")
    elif status == "failed":
        if any(row[f] is not None for f in history):
            raise ValueError("Failed history must be null")
        if reason == "invalid_calldata":
            if ref is not None or any(row[f] is not None for f in calldata):
                raise ValueError("Invalid calldata has observed transfer fields")
        elif reason in ("historical_state_unavailable", "invalid_state_block"):
            if any(row[f] is None for f in calldata):
                raise ValueError("Valid calldata fields must survive history failure")
            if int(row["isZeroAmount"]) != int(int(row["tokenAmount"]) == 0):
                raise ValueError("Contradictory zero-amount flag")
            if (
                reason == "historical_state_unavailable"
                and ref is None
                or reason == "invalid_state_block"
                and (ref is not None or int(row["blockNumber"]) > 0)
            ):
                raise ValueError("Invalid failure reference")
        else:
            raise ValueError("Unknown state failure reason")
    else:
        raise ValueError("Unknown enrichment status")


def category(row, field):
    value = row[field]
    if value is not None and (not isinstance(value, str) or value in ("<NULL>", "<UNKNOWN>")):
        raise ValueError(f"Invalid category: {field}")
    return value


class TrainingPreprocessor:
    def fit(self, rows):
        if not rows:
            raise ValueError("Empty training data")
        vocab = {
            f: sorted({category(r, f) for r in rows if category(r, f) is not None})
            for f in CATEGORICAL
        }
        stats = {}
        for f, transform in NUMERIC.items():
            values = [numeric(r, f) for r in rows]
            observed = [v for v in values if v is not None]
            median = float(statistics.median(observed)) if observed else 0.0
            filled = [median if v is None else v for v in values]
            mean = statistics.fmean(filled)
            std = math.sqrt(statistics.fmean((v - mean) ** 2 for v in filled))
            stats[f] = {
                "transform": transform,
                "unit": UNITS[f],
                "median": median,
                "mean": mean,
                "std": std if std > 0 else 1.0,
                "all_missing_training": not observed,
            }
        names = [
            *[f"standardized:{f}" for f in NUMERIC],
            *[f"missing:{f}" for f in STATE_NUMERIC],
            *[f"{f}={v}" for f in CATEGORICAL for v in ["<UNKNOWN>", "<NULL>", *vocab[f]]],
        ]
        self.data = {
            "version": 2,
            "fit_split": "train",
            "numeric": stats,
            "categorical": vocab,
            "feature_names": names,
            "training_rows": len(rows),
            "training_row_ids_sha256": fingerprint([identity(r) for r in rows]),
        }
        return self

    def metadata(self):
        return copy.deepcopy(self.data)

    @classmethod
    def from_metadata(cls, data):
        if data.get("version") != 2 or list(data["numeric"]) != list(NUMERIC):
            raise ValueError("Incompatible preprocessor version/schema")
        result = cls()
        result.data = copy.deepcopy(data)
        expected = [
            *[f"standardized:{f}" for f in NUMERIC],
            *[f"missing:{f}" for f in STATE_NUMERIC],
            *[
                f"{f}={v}"
                for f in CATEGORICAL
                for v in ["<UNKNOWN>", "<NULL>", *data["categorical"][f]]
            ],
        ]
        if data["feature_names"] != expected:
            raise ValueError("Incompatible feature order")
        return result

    def transform(self, rows):
        vectors = []
        for row in rows:
            values = {f: numeric(row, f) for f in NUMERIC}
            vector = [
                ((s["median"] if values[f] is None else values[f]) - s["mean"]) / s["std"]
                for f, s in self.data["numeric"].items()
            ]
            vector += [float(values[f] is None) for f in STATE_NUMERIC]
            for f, vocab in self.data["categorical"].items():
                value = category(row, f)
                vector += [
                    float(value is not None and value not in vocab),
                    float(value is None),
                    *[float(value == v) for v in vocab],
                ]
            vectors.append(vector)
        result = torch.tensor(vectors, dtype=torch.float32).reshape(
            -1, len(self.data["feature_names"])
        )
        if not torch.isfinite(result).all():
            raise ValueError("Nonfinite transformed inputs")
        return result
