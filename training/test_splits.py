import copy
import unittest

from training.fixtures import CONTRACT, SELECTOR, row
from training.splits import (
    POC_BOUNDS,
    USDT,
    block_bounds,
    check_disjoint,
    validate_e3,
    validate_poc,
)


class SplitTests(unittest.TestCase):
    def test_e3_configurable_windows_filters_and_e2_isolation(self):
        for start, end in ((19010000, 19059999), (19100000, 19100009), (19200000, 19200002)):
            bounds = block_bounds(start, end)
            bounds["unseen-contract"] = bounds["test"]
            selections = {
                s: {
                    "fromBlock": str(lo),
                    "toBlock": str(hi),
                    "erc20BalanceEnrichment": True,
                    "contracts": [
                        {
                            "address": USDT if s == "unseen-contract" else CONTRACT,
                            "functions": [SELECTOR],
                        }
                    ],
                }
                for s, (lo, hi) in bounds.items()
            }
            datasets = {s: [row(lo, i)] for i, (s, (lo, _)) in enumerate(bounds.items())}
            self.assertEqual(validate_e3(selections, datasets), bounds)
            for split, field, value in (
                ("validation", "fromBlock", str(bounds["validation"][0] + 1)),
                ("validation", "erc20BalanceEnrichment", False),
                ("test", "contracts", []),
                ("unseen-contract", "fromBlock", str(bounds["test"][0] - 1)),
                ("unseen-contract", "contracts", selections["train"]["contracts"]),
                ("train", "fromBlock", str(POC_BOUNDS["test"][1])),
            ):
                changed = copy.deepcopy(selections)
                changed[split][field] = value
                with (
                    self.subTest(start=start, split=split, field=field),
                    self.assertRaises(ValueError),
                ):
                    validate_e3(changed, datasets)
            with self.assertRaisesRegex(ValueError, "poc-v3"):
                validate_poc(selections, datasets)
            datasets["test"][0]["transactionHash"] = datasets["train"][0]["transactionHash"]
            with self.assertRaisesRegex(ValueError, "overlaps"):
                validate_e3(selections, datasets)

    def test_inclusive_rounding(self):
        b = block_bounds(19000000, 19002399)
        self.assertEqual(b, {s: POC_BOUNDS[s] for s in ("train", "validation", "test")})
        self.assertEqual(
            block_bounds(100, 102),
            {"train": (100, 100), "validation": (101, 101), "test": (102, 102)},
        )
        for n in (3, 4, 7, 11, 2400):
            bounds = block_bounds(100, 99 + n)
            allocated = [b for lo, hi in bounds.values() for b in range(lo, hi + 1)]
            self.assertEqual(allocated, list(range(100, 100 + n)))
        with self.assertRaisesRegex(ValueError, "Insufficient"):
            block_bounds(1, 2)

    def test_poc_policy_and_overlap(self):
        selections = {
            s: {
                "fromBlock": str(lo),
                "toBlock": str(hi),
                "contracts": [
                    {
                        "address": USDT if s == "unseen-contract" else CONTRACT,
                        "functions": [SELECTOR],
                    }
                ],
            }
            for s, (lo, hi) in POC_BOUNDS.items()
        }
        datasets = {s: [row(lo, i)] for i, (s, (lo, hi)) in enumerate(POC_BOUNDS.items())}
        validate_poc(selections, datasets)
        for split, field, value in (
            ("validation", "contracts", []),
            ("test", "fromBlock", "19001801"),
            ("unseen-contract", "toBlock", "19002400"),
            ("unseen-contract", "contracts", selections["train"]["contracts"]),
        ):
            changed = copy.deepcopy(selections)
            changed[split][field] = value
            with self.assertRaises(ValueError):
                validate_poc(changed, datasets)
        with self.assertRaisesRegex(ValueError, "overlaps"):
            check_disjoint({"train": [row()], "test": [row()]})
        with self.assertRaisesRegex(ValueError, "empty"):
            check_disjoint({"train": []})
