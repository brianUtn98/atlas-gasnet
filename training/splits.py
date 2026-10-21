"""Inclusive block allocation and fixed primary-experiment partition policy."""

from pathlib import Path

from training.prepare_dataset import SPLITS
from training.sources import fingerprint, identity, load_extraction

POC_BOUNDS = {
    "train": (19000000, 19001439),
    "validation": (19001440, 19001799),
    "test": (19001800, 19002399),
    "unseen-contract": (19001800, 19002399),
}
USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7"


def block_bounds(start, end):
    n = end - start + 1
    if n < 3:
        raise ValueError("Insufficient data: at least three inclusive blocks required")
    a = min(max(60 * n // 100, 1), n - 2)
    b = min(max(75 * n // 100, a + 1), n - 1)
    return dict(
        zip(
            SPLITS[:3],
            [(start, start + a - 1), (start + a, start + b - 1), (start + b, end)],
            strict=True,
        )
    )


def check_disjoint(datasets):
    seen = set()
    for rows in datasets.values():
        if not rows:
            raise ValueError("Insufficient data: empty observed partition")
        keys = {identity(row) for row in rows}
        if seen & keys:
            raise ValueError("Transaction identity overlaps splits")
        seen |= keys


def filters(selection):
    return sorted(
        (
            c["address"].lower(),
            bool(c.get("erc20", False)),
            tuple(sorted(s.lower() for s in c["functions"])),
        )
        for c in selection["contracts"]
    )


def validate_poc(selections, datasets):
    ordinary = filters(selections["train"])
    for split in SPLITS:
        selection = selections[split]
        if tuple(int(selection[k]) for k in ("fromBlock", "toBlock")) != POC_BOUNDS[split]:
            raise ValueError("Incorrect poc-v3 block window")
        if split != "unseen-contract" and (
            filters(selection) != ordinary
            or selection.get("erc20BalanceEnrichment")
            != selections["train"].get("erc20BalanceEnrichment")
        ):
            raise ValueError("Ordinary contract/function filters differ")
    unseen = {c[0] for c in filters(selections["unseen-contract"])}
    if unseen != {USDT} or unseen & {c[0] for c in ordinary}:
        raise ValueError("Unseen-contract partition must contain separate USDT")
    check_disjoint(datasets)


def prepare_sources(source: Path, mode="poc"):
    if mode not in ("poc", "smoke"):
        raise ValueError("Unknown source mode")
    if mode == "poc":
        loaded = {s: load_extraction(source / s) for s in SPLITS}
        datasets = {s: pair[0] for s, pair in loaded.items()}
        audits = {s: pair[1] for s, pair in loaded.items()}
        selections = {s: a["manifest"]["selection"] for s, a in audits.items()}
        validate_poc(selections, datasets)
        bounds = POC_BOUNDS
    else:
        rows, audit = load_extraction(source)
        selection = audit["manifest"]["selection"]
        bounds = block_bounds(int(selection["fromBlock"]), int(selection["toBlock"]))
        datasets = {
            s: [r for r in rows if lo <= int(r["blockNumber"]) <= hi]
            for s, (lo, hi) in bounds.items()
        }
        check_disjoint(datasets)
        audits = {"smoke": audit}
    total_blocks = bounds["test"][1] - bounds["train"][0] + 1
    provenance = {
        "version": 2,
        "mode": mode,
        "pipeline_check_only": mode == "smoke",
        "sources": audits,
        "nominal_block_fractions": [0.60, 0.15, 0.25],
        "splits": {
            s: {
                "bounds": list(bounds[s]),
                "rows": len(rows),
                "block_fraction": (bounds[s][1] - bounds[s][0] + 1) / total_blocks,
                "row_ids_sha256": fingerprint([identity(r) for r in rows]),
                "rows_sha256": fingerprint(rows),
            }
            for s, rows in datasets.items()
        },
    }
    return datasets, provenance
