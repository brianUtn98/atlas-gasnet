# Historical EVM extractor

The CLI selects direct calls to configured recipients in an inclusive historical
block range. Network support is separate from the initial Ethereum experiment.

From the repository root, install with `npm --prefix extractor ci` (Node 24 LTS
recommended; package.json lists the supported versions).
Run `npm --prefix extractor run extract -- --config config/extraction.yaml`.
Add `--rpcs config/rpcs.local.yaml` to replace the bundled RPC mapping entirely.
Paths in the selection, including outputDir, resolve from the invocation working
directory (npm's INIT_CWD when using npm --prefix). The bundled RPC path is anchored
to the installed module and does not depend on that directory.
Copy config/rpcs.example.yaml to config/rpcs.local.yaml and replace its placeholders
when using custom providers. Never commit endpoint credentials.

Networks map to viem definitions: ETHEREUM=mainnet (1), ETHEREUM_SEPOLIA=sepolia
(11155111), AVALANCHE=avalanche C-Chain (43114), AVALANCHE_FUJI=avalancheFuji
(43113), POLYGON=polygon (137), POLYGON_AMOY=polygonAmoy (80002).

The YAML selection requires network, fromBlock, toBlock, outputDir and a nonempty
contracts list. Quote block numbers to preserve arbitrary precision. Contracts
have an address and optional nonempty functions and eventTopics lists. Function
entries are canonical signatures (for example `transfer(address,uint256)`) or
four-byte selectors. Topics are 32-byte topic0 hashes. Omit filters for unrestricted
selection; empty filters are errors. Entries combine with OR within each list,
functions and topics combine with AND. Duplicate recipients are errors.

RPC YAML maps uppercase network names to ordered, nonempty HTTP(S) URL lists.
Only the selected network is required in custom files. Unknown networks, invalid
URLs/addresses/ranges, duplicate URLs, and malformed YAML fail before extraction.
Defaults: batchSize=100, retries=3 (allowed 0–10), healthRefreshIntervalMs=30000,
probeTimeoutMs=5000. Batch size and timeouts must be positive bounded integers.

## Public endpoint provenance

Reviewed 2026-10-18 against [Chainlist's RPC listing](https://chainlist.org/rpcs.json):
[Ethereum](https://chainlist.org/chain/1), [Sepolia](https://chainlist.org/chain/11155111),
[Avalanche](https://chainlist.org/chain/43114), [Fuji](https://chainlist.org/chain/43113),
[Polygon](https://chainlist.org/chain/137), [Amoy](https://chainlist.org/chain/80002).
Refresh manually: review those pages/listing, choose credential-free HTTPS entries,
update the YAML/date, run offline tests, and separately probe chain ID, a full block,
and a receipt in your intended historical range. No runtime Chainlist lookup occurs.
Public providers can impose rate limits and retention limits or go offline. A listing
is provenance, not verified uptime, correctness, or historical coverage. Live results
are recorded separately from deterministic tests; use custom RPCs if necessary.

Read-only checks on 2026-10-18 (chain ID, full block at head minus 100, and first
transaction receipt) passed for both Ethereum endpoints at 0x1902309, both Sepolia
endpoints at 0xb643f7, both Avalanche endpoints at 0x5d64770, both Fuji endpoints at
0x38e8129, and Polygon endpoint 0 at 0x5b57b22. Polygon endpoint 1 and Amoy endpoint
0 remain unverified (chain probe failed). Amoy endpoint 1 returned its chain ID and
block 0x3035dc7, but no transaction was available there to verify a receipt. These
results apply only to those probes, not to every historical range. Sandbox network
probes failed; the recorded results came from an explicitly permitted network run.

## RPC routing

Each network has an independent read-only RPCManager. It probes identity and head
at startup and request-driven refreshes every 30 seconds (configurable); at most
four probes run together, each with a 5 second configurable timeout. Overlapping
refreshes coalesce. Unexpired healthy observations rank by descending head, then
configuration order. Nodes below the requested height are excluded. Failed nodes
can recover on later refreshes. The interface exposes block and receipt reads only.
Reads retry transient errors up to retries times with 250 ms exponential backoff,
capped at 30 seconds; structured Retry-After seconds/dates are honored up to that
cap. Exhaustion or invalid historical data falls back in head order. An endpoint
rejected for a read is never revisited in that read. All failures abort unresolved
work; diagnostics use network names and endpoint indexes, never provider errors.
Head freshness is a routing heuristic: independently validate historical block,
transaction and receipt identities. A recent high head proves neither historical
coverage nor correctness. There is no quorum or automatic reorganization repair.

## Selection and bias

Discovery scans both range endpoints and selects only top-level recipients; internal
calls, router interactions and event-only discovery are outside scope. Receipts must
match the selected transaction, block hash, height, position, sender and recipient.
Invalid responses trigger fallback while retaining that selected block hash. Missing
receipts fail the batch instead of skipping a row. Without topics, reverted direct
calls are retained. Topic filtering selects on execution outcomes: reverted calls
without persisted logs are excluded. Record this selection bias when training; event
presence and receipt status are never pre-execution predictors.

## Version 1 data dictionary

Rows are keyed by `(chainId, transactionHash)`. Hex is lowercase; decimal strings
are exact unsigned integers. All fields are required except the four explicitly
nullable fields below. C = eligible pre-execution candidate, T = target, A = audit.
Candidates are an eligibility boundary, not automatic MLP inputs.

| Field | Source / derivation | Role | Type, encoding and units | Nullable |
| --- | --- | --- | --- | --- |
| from | transaction sender | C | string, 20-byte address | no |
| to | top-level transaction recipient | C | string, 20-byte address; creations excluded | no |
| type | transaction type; viem name to numeric code | C | integer EIP-2718 type (legacy=0, 2930=1, 1559=2, 4844=3, 7702=4) | no |
| nonce | submitted transaction nonce | C | exact decimal string, sender sequence number | no |
| value | submitted native transfer | C | exact decimal string, native base units (18 decimals on these networks) | no |
| gasLimit | transaction gas | C | exact decimal string, gas units, execution cap | no |
| gasPrice | submitted legacy/type-1 fee | C | exact decimal string, wei/gas; null for dynamic fees even if RPC supplies mined price | yes |
| maxFeePerGas | submitted dynamic fee cap | C | exact decimal string, wei/gas; null for legacy/type-1 | yes |
| maxPriorityFeePerGas | submitted dynamic priority cap | C | exact decimal string, wei/gas; null for legacy/type-1 | yes |
| input | full submitted calldata | C | string, hex bytes; empty=0x | no |
| accessList | submitted ordered address/storageKeys entries | C | canonical JSON string with lowercase hex; absent=[]; duplicates retained | no |
| functionSelector | first four input bytes | C | four-byte hex string; null for shorter input; no decoded name | yes |
| calldataBytes | full input byte count, including selector | C | integer, bytes; empty=0 | no |
| calldataZeroBytes | full input bytes equal to 00 | C | integer, bytes; empty=0 | no |
| calldataNonzeroBytes | calldataBytes minus calldataZeroBytes | C | integer, bytes; empty=0 | no |
| accessListAddressCount | number of ordered access-list entries | C | integer count; absent=0 | no |
| accessListStorageKeyCount | sum of all listed storage-key entries, including duplicates | C | integer count; absent=0 | no |
| gasUsed | receipt gasUsed | T | exact decimal string, gas units consumed | no |
| chainName | selected, RPC-verified registry network | C | uppercase categorical string | no |
| chainId | selected, RPC-verified registry chain ID | A | exact decimal string | no |
| transactionHash | transaction identity, receipt cross-check | A | string, 32-byte hex | no |
| blockHash | inclusion block, transaction/receipt cross-check | A | string, 32-byte hex | no |
| blockNumber | inclusion block height | A | exact decimal string, numeric chronological ordering | no |
| transactionIndex | inclusion position, receipt cross-check | A | exact decimal string, numeric ordering within block | no |
| blockTimestamp | inclusion block timestamp | A | exact decimal string, UTC Unix seconds | no |
| receiptStatus | receipt outcome | A | string, success or reverted; neither filtered by default | no |
| schemaVersion | extractor dictionary version | A | string, initially 1 | no |

The seven initial hypotheses are chainName, to, calldataBytes, functionSelector,
calldataNonzeroBytes, value, accessListStorageKeyCount. Encode network, recipient
and selector categorically together; selectors are not ordinal numbers. Network
is constant in single-network experiments and testnets are not pooled automatically.
Calldata size and composition may affect costs: derive nonzero/total with zero for
empty calldata. Total, zero and nonzero counts are exactly dependent; avoid treating
all three as independent signals. Native value may change execution paths but is
not an ERC-20 amount: token transfer amounts live in input, so USDC calls often have
value=0. Declared storage keys participate in gas accounting; their count is not the
actual number of storage accesses. Constant or redundant candidates may be dropped
after inspecting variation. None promises improved predictive performance.

Other candidates permit controlled experiments. Sender, nonce, raw calldata and
access lists need explicit encoding; gas fees are monetary terms rather than primary
indicators of computational work. Gas limit can reflect an upstream estimator and
must be analyzed separately from consumption. Receipt logs, effectiveGasPrice,
cumulativeGasUsed and inclusion-block gas totals are not candidate features. Hashes,
inclusion position/time, outcome and schema metadata are audit-only.

Protocol references: [transactions](https://ethereum.org/developers/docs/transactions/),
[access-list accounting](https://eips.ethereum.org/EIPS/eip-2930),
[calldata accounting](https://eips.ethereum.org/EIPS/eip-7623).

## Parquet handoff

The maintained [hyparquet-writer](https://github.com/hyparam/hyparquet-writer)
writes flat, uncompressed Parquet parts. Every string in the dictionary is a
BYTE_ARRAY annotated UTF8 (including decimal quantities and JSON accessList).
The type code and five derived counts use INT32. Only gasPrice, maxFeePerGas,
maxPriorityFeePerGas and functionSelector are OPTIONAL; other columns are REQUIRED.
Schema version is also recorded in file metadata. Empty parts retain the full schema.
Rows sort numerically by chain ID, block height and inclusion index, and duplicate
identities deduplicate; conflicting duplicates are errors. Decimal columns sort
lexicographically in generic tools, so explicitly convert before numeric analysis.

```python
from pathlib import Path
import json
import pandas as pd

run = Path("data/extractions/usdc-example")
manifest = json.loads((run / "manifest.json").read_text())
df = pd.concat([pd.read_parquet(run / part["file"]) for part in manifest["parts"]], ignore_index=True)
# Python int preserves exact values; do not convert via float64.
for field in ["value", "gasLimit", "gasUsed", "nonce", "blockNumber", "transactionIndex", "blockTimestamp"]:
    df[field] = df[field].map(int)
df = df.sort_values(["blockNumber", "transactionIndex"])
df["nonzeroRatio"] = [nz / size if size else 0 for nz, size in zip(df.calldataNonzeroBytes, df.calldataBytes)]
# Explicitly choose and encode candidates before training; never use audit columns.
```

Install pandas and a Parquet engine (for example pyarrow) in Python/Colab. Nullable
fee strings can be parsed with `None if pd.isna(x) else int(x)`. ERC-20 amounts
require contract-aware calldata decoding; they cannot be obtained by rescaling value.
CSV export and automatic training are outside this extractor.

## Durable runs and resume

Use one output directory per selection and one writer per run. Deterministic part
names encode inclusive batch bounds. Each part is finished, file-synced, closed,
and atomically renamed before the checkpoint is file-synced and atomically replaced.
Directory entries are also synced on POSIX; Windows cannot fsync directory handles,
so guarantees target process interruption rather than hardware power-loss recovery.
Temporary files end in .tmp. A crash before checkpoint replacement replays/replaces
the same part. Checkpointed batch size is reused even if the CLI setting changes.
Empty batches create schema-bearing zero-row parts and advance their block boundary.

Rerun the same command to resume. A versioned fingerprint binds network, range,
normalized recipient/selector/topic sets and schema. Endpoint, output-path and retry
settings are excluded; endpoints may change without changing dataset selection.
Changed selections/schemas are rejected: use the original selection or a new output
directory. Checkpoints retain nextBlock, original batch size, committed parts, row
counts, content checksums and the last committed block hash. Resume verifies the
committed bytes and re-reads that last block; a changed/unverifiable hash stops work.
This is a historical-range anchor check, not automatic chain reconciliation.

Missing blocks/receipts or exhausted RPCs leave the unfinished batch uncommitted.
Rows deduplicate within parts; repeated identities across committed batches fail.
manifest.json is reconciled from durable checkpointed parts after failures/resume,
and records selection, schema, roles, physical columns, row counts, boundaries and
completion. Uncheckpointed orphan parts are excluded; Python should read only the
parts named in the manifest. Complete means every requested block is committed,
including a valid zero-match run. Neither checkpoints nor manifests contain RPC URLs.
Do not edit/check in generated run state. Custom configs and data/extractions are ignored.

## Verification commands

From the repository root:

```sh
npm --prefix extractor run build
npm --prefix extractor run typecheck
npm --prefix extractor run test:unit
npm --prefix extractor run test:integration
node extractor/dist/cli.js --help
node extractor/dist/cli.js --config config/extraction.yaml
node extractor/dist/cli.js --config config/extraction.yaml --rpcs config/rpcs.local.yaml
```

Build before the CLI integration test, which runs the compiled command against a
local deterministic HTTP RPC fixture. Unit tests use mocks/fake timers, no private
credentials, live endpoints or real backoff delays. Live endpoint reviews and smoke
extraction are separate and never prerequisites for offline tests.

## Recorded verification — 2026-10-18

- Clean lockfile install: `npm ci --offline --ignore-scripts` in extractor passed;
  npm reported zero vulnerabilities. The checked-in lockfile pins resolved versions.
- `npm --prefix extractor run build` and `npm --prefix extractor run typecheck` passed.
- `npm --prefix extractor test`: 126 tests passed across 11 files, including all
  offline unit tests and CLI/Parquet/resume fixture integration tests. These verify
  newer-head preference, invalid-response fallback, exact raw RPC nonce/value
  above 2^53, and unchanged unfinished checkpoints after RPC exhaustion.
- The compiled help/custom-config CLI ran against a temporary local HTTP fixture;
  bundled configuration ran through viem with mocked HTTP. npm INIT_CWD path
  handling was verified with a relative selection and relative output directory.
- `git check-ignore` confirmed custom local RPC YAML, Parquet output and checkpoints
  are ignored. The public RPC map and placeholder examples are not ignored.
- `openspec validate add-evm-transaction-extractor --strict --json` passed.
- Live smoke: `npm --prefix extractor run extract -- --config config/extraction.yaml`
  passed against bundled public Ethereum RPCs, selecting 11 direct USDC transfers
  in inclusive blocks 19000000–19000002. One part was committed, manifest.complete
  was true and nextBlock was 19000003. This sample verifies only that selection/range;
  it does not establish uptime or historical coverage for other networks/ranges.

On this Windows host, sandboxed temporary checkpoint replacement returned EPERM.
The same resume test and final full suite passed outside the sandbox. Network
probes and the smoke run also used explicitly permitted network access. Offline
unit tests passed inside the sandbox without live RPCs or private credentials.
