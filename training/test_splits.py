import copy
import unittest

from training.fixtures import CONTRACT, SELECTOR, row
from training.splits import POC_BOUNDS, USDT, block_bounds, check_disjoint, validate_poc


class SplitTests(unittest.TestCase):
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
