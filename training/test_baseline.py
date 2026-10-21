import unittest

from training.baseline import SelectorMedian
from training.fixtures import row


class BaselineTests(unittest.TestCase):
    def test_hand_calculated_medians_and_fallback(self):
        rows = [
            row(gasUsed=str(y), functionSelector=s, to=c)
            for y, s, c in [
                (10, "a", "one"),
                (30, "a", "two"),
                (20, "a", "one"),
                (40, "b", "one"),
                (60, "b", "two"),
                (100, None, "three"),
            ]
        ]
        b = SelectorMedian().fit(rows)
        self.assertEqual(b.data["selector_medians"], {"a": 20, "b": 50})
        self.assertEqual(b.data["global_median"], 35)
        held = [row(functionSelector=s, gasUsed="99999") for s in ("a", "b", "new", None)]
        self.assertEqual(b.predict(held), ([20, 50, 35, 35], 2))
        for r in held:
            r["gasUsed"] = "1"
        self.assertEqual(SelectorMedian.from_metadata(b.data).predict(held), ([20, 50, 35, 35], 2))

    def test_invalid_fit(self):
        for rows in (
            [],
            [row(gasUsed="0")],
            [row(gasUsed="-1")],
            [row(gasUsed="nan")],
            [row(gasUsed=str(2**63))],
        ):
            with self.assertRaises(ValueError):
                SelectorMedian().fit(rows)

    def test_large_even_median_keeps_exact_statistics(self):
        a = 2**53
        b = SelectorMedian().fit([row(gasUsed=str(a)), row(gasUsed=str(a + 1))])
        self.assertEqual(b.data["exact_global_median"], f"{2 * a + 1}/2")
