import copy
import tempfile
import unittest
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

from training.fixtures import extraction, row
from training.prepare_dataset import digest, write_json
from training.sources import load_extraction


class SourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "source"

    def test_exact_unique_ordered_and_only_listed(self):
        a = row(
            100, value=str(2**256 - 1), tokenAmount=str(2**53 + 1), amountToSenderBalanceRatio="1/3"
        )
        m = extraction(self.path, [row(101), a, copy.deepcopy(a)])
        m["parts"].append(copy.deepcopy(m["parts"][0]))
        write_json(self.path / "manifest.json", m)
        (self.path / "transactions.json").write_text("not JSON")
        (self.path / "report.pdf").write_text("not PDF")
        (self.path / "unlisted.parquet").write_text("not Parquet")
        rows, audit = load_extraction(self.path)
        self.assertEqual([r["blockNumber"] for r in rows], ["100", "101"])
        self.assertEqual(rows[0]["value"], str(2**256 - 1))
        self.assertEqual(rows[0]["amountToSenderBalanceRatio"], "1/3")
        self.assertEqual(audit["duplicate_rows"], 1)

    def test_conflicting_duplicates(self):
        extraction(self.path, [row(), row(gasUsed="22000")])
        with self.assertRaisesRegex(ValueError, "Conflicting duplicate"):
            load_extraction(self.path)

    def test_manifest_failures(self):
        original = extraction(self.path)
        mutations = [
            lambda m: m.update(schemaVersion="2"),
            lambda m: m["selection"].update(network="POLYGON"),
            lambda m: m.update(complete=False),
            lambda m: m.update(nextBlock="109"),
            lambda m: m.update(rowCount=999),
            lambda m: m["parts"][0].update(rows=999),
            lambda m: m["parts"][0].update(fromBlock="101"),
            lambda m: m["parts"][0].update(file="../outside.parquet"),
            lambda m: m["parts"][0].update(file="missing.parquet"),
            lambda m: m["parts"][0].update(sha256="bad"),
            lambda m: m.update(physicalSchema=[]),
            lambda m: m["selection"]["contracts"][0].update(functions=["0xdeadbeef"]),
        ]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                m = copy.deepcopy(original)
                mutate(m)
                write_json(self.path / "manifest.json", m)
                with self.assertRaises(ValueError):
                    load_extraction(self.path)

    def test_physical_schema_and_corruption(self):
        m = extraction(self.path)
        pq.write_table(pa.table({"wrong": [1]}), self.path / "part.parquet")
        m["parts"][0]["sha256"] = digest(self.path / "part.parquet")
        write_json(self.path / "manifest.json", m)
        with self.assertRaisesRegex(ValueError, "physical"):
            load_extraction(self.path)
        (self.path / "part.parquet").write_bytes(b"broken")
        m["parts"][0]["sha256"] = digest(self.path / "part.parquet")
        write_json(self.path / "manifest.json", m)
        with self.assertRaises(pa.ArrowInvalid):
            load_extraction(self.path)

    def test_row_network_range_null_and_target(self):
        for changes in (
            {"chainId": "2"},
            {"blockNumber": "111"},
            {"gasUsed": "0"},
            {"gasUsed": str(2**63)},
        ):
            with self.subTest(changes=changes):
                if self.path.exists():
                    for p in self.path.iterdir():
                        p.unlink()
                    self.path.rmdir()
                extraction(self.path, [row(**changes)])
                with self.assertRaises(ValueError):
                    load_extraction(self.path)
