"""Small generated schema-3 sources for offline tests; never experimental data."""

from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

from training.prepare_dataset import STATE_NUMERIC, digest, write_json
from training.sources import ARROW_SCHEMA, FIELDS, INTS, PHYSICAL
from training.splits import POC_BOUNDS, USDT

CONTRACT = "0x" + "ab" * 20
SELECTOR = "0xa9059cbb"


def row(block=100, index=0, **changes):
    value = {n: 0 if n in INTS else "0" for n in FIELDS}
    value.update({n: None for n in STATE_NUMERIC})
    value.update(
        chainId="1",
        chainName="ETHEREUM",
        schemaVersion="3",
        blockNumber=str(block),
        transactionIndex=str(index),
        transactionHash="0x" + f"{block * 100 + index:064x}",
        blockHash="0x" + "cd" * 32,
        to=CONTRACT,
        functionSelector=SELECTOR,
        accessList="[]",
        input="0x",
        stateBlockNumber=None,
        stateEnrichmentStatus="not_applicable",
        stateEnrichmentReason="disabled",
        gasUsed=str(21000 + index * 100),
        gasPrice=None,
        maxFeePerGas=None,
        maxPriorityFeePerGas=None,
    )
    value.update(changes)
    return value


def extraction(directory, rows=None, start=100, end=109):
    directory = Path(directory)
    directory.mkdir(parents=True)
    rows = rows if rows is not None else [row(b) for b in range(start, end + 1)]
    schema = ARROW_SCHEMA.with_metadata({b"atlas.schemaVersion": b"3"})
    pq.write_table(pa.Table.from_pylist(rows, schema=schema), directory / "part.parquet")
    manifest = {
        "schemaVersion": "3",
        "selection": {
            "schemaVersion": "3",
            "network": "ETHEREUM",
            "fromBlock": str(start),
            "toBlock": str(end),
            "contracts": [{"address": CONTRACT, "functions": [SELECTOR]}],
        },
        "physicalSchema": PHYSICAL,
        "complete": True,
        "nextBlock": str(end + 1),
        "lastCommittedBlock": str(end),
        "rowCount": len(rows),
        "parts": [
            {
                "file": "part.parquet",
                "sha256": digest(directory / "part.parquet"),
                "fromBlock": str(start),
                "toBlock": str(end),
                "rows": len(rows),
            }
        ],
    }
    write_json(directory / "manifest.json", manifest)
    return manifest


def poc_extraction(directory):
    """Four declared partitions, including empty blocks and separate USDT rows."""
    for index, (split, (lo, hi)) in enumerate(POC_BOUNDS.items()):
        contract = USDT if split == "unseen-contract" else CONTRACT
        path = Path(directory) / split
        m = extraction(path, [row(lo, index, to=contract), row(hi, index, to=contract)], lo, hi)
        m["selection"]["contracts"][0]["address"] = contract
        write_json(path / "manifest.json", m)
