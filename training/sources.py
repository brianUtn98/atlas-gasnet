"""Strict offline schema-3 Parquet ingestion; no discovery of extra observations."""

import hashlib
import json
import re
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

from training.prepare_dataset import STATE_NUMERIC, digest, read_json

FIELDS = [
    *STATE_NUMERIC,
    "from",
    "to",
    "type",
    "nonce",
    "value",
    "gasLimit",
    "gasPrice",
    "maxFeePerGas",
    "maxPriorityFeePerGas",
    "input",
    "accessList",
    "functionSelector",
    "calldataBytes",
    "calldataZeroBytes",
    "calldataNonzeroBytes",
    "accessListAddressCount",
    "accessListStorageKeyCount",
    "chainName",
    "gasUsed",
    "stateBlockNumber",
    "stateEnrichmentStatus",
    "stateEnrichmentReason",
    "chainId",
    "transactionHash",
    "blockHash",
    "blockNumber",
    "transactionIndex",
    "blockTimestamp",
    "receiptStatus",
    "schemaVersion",
]
INTS = {
    "isZeroAmount",
    "isSelfTransfer",
    "senderHasEnoughBalance",
    "recipientBalanceWasZero",
    "senderBalanceEqualsAmount",
    "type",
    "calldataBytes",
    "calldataZeroBytes",
    "calldataNonzeroBytes",
    "accessListAddressCount",
    "accessListStorageKeyCount",
}
NULLABLE = {
    *STATE_NUMERIC,
    "stateBlockNumber",
    "stateEnrichmentReason",
    "gasPrice",
    "maxFeePerGas",
    "maxPriorityFeePerGas",
    "functionSelector",
}
PHYSICAL = [
    {"name": n, "type": "INT32" if n in INTS else "STRING", "nullable": n in NULLABLE}
    for n in FIELDS
]
ARROW_SCHEMA = pa.schema(
    [pa.field(n, pa.int32() if n in INTS else pa.string(), nullable=n in NULLABLE) for n in FIELDS]
)


def fingerprint(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    ).hexdigest()


def unsigned(value, field, maximum=2**256 - 1):
    if isinstance(value, bool) or not re.fullmatch(r"[0-9]+", str(value)):
        raise ValueError(f"Invalid unsigned integer: {field}")
    result = int(value)
    if result > maximum:
        raise ValueError(f"Out of range: {field}")
    return result


def identity(row):
    return f"{unsigned(row['chainId'], 'chainId')}:{row['transactionHash'].lower()}"


def normalize(row):
    row = dict(row)
    for name in ("from", "to", "transactionHash", "blockHash", "input", "functionSelector"):
        if row[name] is not None:
            row[name] = row[name].lower()
    for name in ("chainId", "blockNumber", "transactionIndex", "blockTimestamp"):
        row[name] = str(unsigned(row[name], name))
    # Access lists are JSON in the physical format; normalize their structural encoding.
    row["accessList"] = json.dumps(json.loads(row["accessList"]), sort_keys=True)
    return row


def load_extraction(directory: Path):
    directory = Path(directory).resolve()
    manifest = read_json(directory / "manifest.json")
    selection = manifest["selection"]
    start, end = (unsigned(selection[k], k) for k in ("fromBlock", "toBlock"))
    if (
        manifest["schemaVersion"] != "3"
        or selection["schemaVersion"] != "3"
        or selection["network"] != "ETHEREUM"
        or manifest["physicalSchema"] != PHYSICAL
    ):
        raise ValueError("Unexpected source schema/network")
    if (
        not manifest["complete"]
        or start > end
        or unsigned(manifest["nextBlock"], "nextBlock") != end + 1
        or unsigned(manifest["lastCommittedBlock"], "lastCommittedBlock") != end
    ):
        raise ValueError("Incomplete block coverage")
    contracts = {
        c["address"].lower(): {s.lower() for s in c["functions"]} for c in selection["contracts"]
    }
    rows, parts, seen_paths = [], [], {}
    for part in manifest["parts"]:
        path = (directory / part["file"]).resolve()
        if not path.is_relative_to(directory) or path.suffix != ".parquet":
            raise ValueError("Part path escapes extraction directory or is not Parquet")
        if path in seen_paths:
            if part != seen_paths[path]:
                raise ValueError("Conflicting repeated part reference")
            continue
        seen_paths[path] = part
        if not path.is_file() or digest(path) != part["sha256"]:
            raise ValueError("Missing/corrupt source part")
        table = pq.read_table(path)
        if (
            not table.schema.equals(ARROW_SCHEMA, check_metadata=False)
            or (table.schema.metadata or {}).get(b"atlas.schemaVersion") != b"3"
        ):
            raise ValueError("Incompatible physical Parquet schema")
        decoded = table.to_pylist()  # No floating conversion of nullable INT32 or exact strings.
        lo, hi = (unsigned(part[k], k) for k in ("fromBlock", "toBlock"))
        if len(decoded) != part["rows"] or not start <= lo <= hi <= end:
            raise ValueError("Part row count/range mismatch")
        for raw in decoded:
            if any(raw[n] is None for n in FIELDS if n not in NULLABLE):
                raise ValueError("Null required schema field")
            row = normalize(raw)
            if (
                row["schemaVersion"] != "3"
                or row["chainId"] != "1"
                or row["chainName"] != "ETHEREUM"
                or not lo <= int(row["blockNumber"]) <= hi
                or row["to"] not in contracts
                or (contracts[row["to"]] and row["functionSelector"] not in contracts[row["to"]])
            ):
                raise ValueError("Row outside source selection")
            if not unsigned(row["gasUsed"], "gasUsed", 2**63 - 1):
                raise ValueError("gasUsed must be positive")
            rows.append(row)
        parts.append((lo, hi))
    cursor = start
    for lo, hi in sorted(parts):
        if lo != cursor:
            raise ValueError("Incomplete or overlapping block coverage")
        cursor = hi + 1
    if cursor != end + 1 or len(rows) != manifest["rowCount"]:
        raise ValueError("Manifest row count/coverage mismatch")
    unique = {}
    for row in rows:
        key = identity(row)
        if key in unique and unique[key] != row:
            raise ValueError("Conflicting duplicate transaction")
        unique[key] = row
    ordered = sorted(
        unique.values(),
        key=lambda r: (int(r["blockNumber"]), int(r["transactionIndex"]), r["transactionHash"]),
    )
    return ordered, {
        "manifest": manifest,
        "manifest_sha256": digest(directory / "manifest.json"),
        "source_rows": len(rows),
        "retained_rows": len(ordered),
        "duplicate_rows": len(rows) - len(ordered),
        "rows_sha256": fingerprint(ordered),
    }
