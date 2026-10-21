"""Training-only median by function selector, with global fallback."""

import statistics
from collections import defaultdict
from fractions import Fraction

from training.sources import unsigned


def labels(rows):
    values = [unsigned(r["gasUsed"], "gasUsed", 2**63 - 1) for r in rows]
    if not values or min(values) <= 0:
        raise ValueError("Empty fitting data or nonpositive gasUsed")
    return values


def exact_median(values):
    ordered = sorted(values)
    middle = len(ordered) // 2
    value = (
        Fraction(ordered[middle])
        if len(ordered) % 2
        else Fraction(ordered[middle - 1] + ordered[middle], 2)
    )
    return f"{value.numerator}/{value.denominator}"


class SelectorMedian:
    def fit(self, rows):
        y = labels(rows)
        groups = defaultdict(list)
        for row, target in zip(rows, y, strict=True):
            selector = row["functionSelector"]
            if selector is not None:
                groups[selector.lower()].append(target)
        self.data = {
            "version": 1,
            "global_median": statistics.median(y),
            "selector_medians": {s: statistics.median(v) for s, v in sorted(groups.items())},
            "exact_global_median": exact_median(y),
            "exact_selector_medians": {s: exact_median(v) for s, v in sorted(groups.items())},
            "training_rows": len(rows),
            "fallback": "global_training_median",
        }
        return self

    def predict(self, rows):
        medians = self.data["selector_medians"]
        selectors = [r["functionSelector"].lower() if r["functionSelector"] else None for r in rows]
        return (
            [medians.get(s, self.data["global_median"]) for s in selectors],
            sum(s not in medians for s in selectors),
        )

    @classmethod
    def from_metadata(cls, data):
        if data.get("version") != 1:
            raise ValueError("Incompatible baseline version")
        obj = cls()
        obj.data = data
        return obj
