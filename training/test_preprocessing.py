import copy
import math
import unittest

import torch

from training.fixtures import row
from training.prepare_dataset import BASE_NUMERIC, STATE_NUMERIC
from training.preprocessing import TrainingPreprocessor, numeric, validate_state


def complete(**changes):
    return row(
        stateEnrichmentStatus="complete",
        stateEnrichmentReason=None,
        stateBlockNumber="99",
        tokenAmount="1",
        isZeroAmount=0,
        isSelfTransfer=0,
        senderTokenBalanceBeforeBlock="3",
        recipientTokenBalanceBeforeBlock="0",
        senderHasEnoughBalance=1,
        recipientBalanceWasZero=1,
        senderBalanceEqualsAmount=0,
        amountToSenderBalanceRatio="1/3",
        **changes,
    )


class PreprocessorTests(unittest.TestCase):
    def test_exact_boundaries_and_invalid_values(self):
        for amount in (0, 2**53 + 1, 2**256 - 1):
            self.assertEqual(
                numeric(row(tokenAmount=str(amount)), "tokenAmount"), math.log1p(amount)
            )
        self.assertEqual(numeric(complete(), "amountToSenderBalanceRatio"), math.log1p(1 / 3))
        for field, value in (
            ("value", "-1"),
            ("tokenAmount", str(2**256)),
            ("calldataBytes", True),
            ("value", "nan"),
            ("isZeroAmount", 2),
            ("calldataBytes", 2**31),
            ("amountToSenderBalanceRatio", "1/0"),
            ("amountToSenderBalanceRatio", "2/6"),
            ("amountToSenderBalanceRatio", f"{2**256}/1"),
        ):
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                numeric(row(**{field: value}), field)
        for field in BASE_NUMERIC:
            with self.assertRaises(ValueError):
                numeric(row(**{field: None}), field)

    def test_state_semantics(self):
        valid = [
            row(),
            complete(),
            row(stateEnrichmentStatus="failed", stateEnrichmentReason="invalid_calldata"),
            row(
                stateEnrichmentStatus="failed",
                stateEnrichmentReason="historical_state_unavailable",
                stateBlockNumber="99",
                tokenAmount="0",
                isZeroAmount=1,
                isSelfTransfer=1,
            ),
        ]
        zero = complete()
        zero.update(
            tokenAmount="0",
            isZeroAmount=1,
            senderTokenBalanceBeforeBlock="0",
            amountToSenderBalanceRatio=None,
            senderBalanceEqualsAmount=1,
        )
        valid.append(zero)
        for r in valid:
            validate_state(r)
        for changes in (
            {"stateBlockNumber": "100"},
            {"senderHasEnoughBalance": 0},
            {"amountToSenderBalanceRatio": None},
            {"stateEnrichmentReason": "oops"},
            {"senderTokenBalanceBeforeBlock": None},
        ):
            r = complete()
            r.update(changes)
            with self.assertRaises(ValueError):
                validate_state(r)
        for r in (
            row(tokenAmount="1"),
            row(
                stateEnrichmentStatus="failed", stateEnrichmentReason="historical_state_unavailable"
            ),
        ):
            with self.assertRaises(ValueError):
                validate_state(r)

    def test_frozen_all_missing_null_unknown_constants_and_leakage(self):
        p = TrainingPreprocessor().fit([row(), row(101, functionSelector=None)])
        metadata = p.metadata()
        for f in STATE_NUMERIC:
            self.assertTrue(metadata["numeric"][f]["all_missing_training"])
            self.assertEqual(metadata["numeric"][f]["std"], 1)
        held = complete()
        held.update(value=str(2**256 - 1), to="unknown", functionSelector=None)
        x = p.transform([held])
        self.assertTrue(torch.isfinite(x).all())
        self.assertEqual(x[0, metadata["feature_names"].index("to=<UNKNOWN>")], 1)
        self.assertEqual(x[0, metadata["feature_names"].index("functionSelector=<NULL>")], 1)
        changed = copy.deepcopy(held)
        for f in (
            "gasUsed",
            "receiptStatus",
            "blockTimestamp",
            "transactionHash",
            "gasLimit",
            "nonce",
            "input",
            "from",
            "stateEnrichmentStatus",
            "stateEnrichmentReason",
        ):
            changed[f] = "arbitrary audit"
        self.assertTrue(torch.equal(x, p.transform([changed])))
        self.assertEqual(p.metadata(), metadata)
        reloaded = TrainingPreprocessor.from_metadata(metadata)
        self.assertTrue(torch.equal(x, reloaded.transform([held])))
        self.assertEqual(
            p.transform([row()])[0, metadata["feature_names"].index("missing:tokenAmount")], 1
        )
        self.assertEqual(
            p.transform([held])[0, metadata["feature_names"].index("missing:tokenAmount")], 0
        )
