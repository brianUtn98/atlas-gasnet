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

## Output formats

Choose exports in the extraction YAML, for example:

```yaml
outputDir: data/extractions/usdc-example
outputFormats: [parquet, pdf, json]
```

The versioned repository configuration explicitly enables all three; omitted
outputFormats also defaults to all three. Any nonempty subset is accepted, such
as `[json]` or `[parquet, pdf]`. Unknown, uppercase, duplicate, empty or non-list
values fail validation. There are no separate CLI format flags.

- `parquet`: deterministic `part-FROM-TO.parquet` batches with the version-1 schema.
- `json`: `transactions.json`, an array of every committed row, in numeric block
  and transaction-index order, not just the PDF sample. Exact quantities remain
  decimal strings, counts/type remain JSON numbers, null fee/selector fields stay
  null, and accessList retains the schema's canonical JSON-string encoding. A
  zero-match run exports `[]`.
- `pdf`: `report.pdf`, the human-readable summary and bounded transaction sample.

checkpoint.json and manifest.json are always operational metadata, irrespective
of JSON export selection. When Parquet is disabled, durable batch data uses internal
`batch-FROM-TO.checkpoint` files so resume still works without producing unrequested
Parquet exports. Preserve those files along with the checkpoint. The manifest's
`parts` describes durable batch files; `outputs` lists requested formats and export
filenames, including `outputs.parquetFiles` for Parquet consumers.

Formats do not change the selection fingerprint. They may be changed on resume:
newly enabled formats are generated from committed data, without scanning completed
blocks again (the existing resume anchor check still runs). Future unfinished
batches use the current format choice; previously created exports/state are retained,
not deleted. Use a new output directory when you need only the currently selected
files. JSON/PDF snapshots are atomically replaced at completion and best-effort after
extraction failures, using committed rows only. Export failure preserves extraction
progress but fails the command; rerun to regenerate. Manifest.complete describes
data coverage, not a guarantee that an interrupted export write finished.

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

| Field                     | Source / derivation                                         | Role | Type, encoding and units                                                              | Nullable |
| ------------------------- | ----------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------- | -------- |
| from                      | transaction sender                                          | C    | string, 20-byte address                                                               | no       |
| to                        | top-level transaction recipient                             | C    | string, 20-byte address; creations excluded                                           | no       |
| type                      | transaction type; viem name to numeric code                 | C    | integer EIP-2718 type (legacy=0, 2930=1, 1559=2, 4844=3, 7702=4)                      | no       |
| nonce                     | submitted transaction nonce                                 | C    | exact decimal string, sender sequence number                                          | no       |
| value                     | submitted native transfer                                   | C    | exact decimal string, native base units (18 decimals on these networks)               | no       |
| gasLimit                  | transaction gas                                             | C    | exact decimal string, gas units, execution cap                                        | no       |
| gasPrice                  | submitted legacy/type-1 fee                                 | C    | exact decimal string, wei/gas; null for dynamic fees even if RPC supplies mined price | yes      |
| maxFeePerGas              | submitted dynamic fee cap                                   | C    | exact decimal string, wei/gas; null for legacy/type-1                                 | yes      |
| maxPriorityFeePerGas      | submitted dynamic priority cap                              | C    | exact decimal string, wei/gas; null for legacy/type-1                                 | yes      |
| input                     | full submitted calldata                                     | C    | string, hex bytes; empty=0x                                                           | no       |
| accessList                | submitted ordered address/storageKeys entries               | C    | canonical JSON string with lowercase hex; absent=[]; duplicates retained              | no       |
| functionSelector          | first four input bytes                                      | C    | four-byte hex string; null for shorter input; no decoded name                         | yes      |
| calldataBytes             | full input byte count, including selector                   | C    | integer, bytes; empty=0                                                               | no       |
| calldataZeroBytes         | full input bytes equal to 00                                | C    | integer, bytes; empty=0                                                               | no       |
| calldataNonzeroBytes      | calldataBytes minus calldataZeroBytes                       | C    | integer, bytes; empty=0                                                               | no       |
| accessListAddressCount    | number of ordered access-list entries                       | C    | integer count; absent=0                                                               | no       |
| accessListStorageKeyCount | sum of all listed storage-key entries, including duplicates | C    | integer count; absent=0                                                               | no       |
| gasUsed                   | receipt gasUsed                                             | T    | exact decimal string, gas units consumed                                              | no       |
| chainName                 | selected, RPC-verified registry network                     | C    | uppercase categorical string                                                          | no       |
| chainId                   | selected, RPC-verified registry chain ID                    | A    | exact decimal string                                                                  | no       |
| transactionHash           | transaction identity, receipt cross-check                   | A    | string, 32-byte hex                                                                   | no       |
| blockHash                 | inclusion block, transaction/receipt cross-check            | A    | string, 32-byte hex                                                                   | no       |
| blockNumber               | inclusion block height                                      | A    | exact decimal string, numeric chronological ordering                                  | no       |
| transactionIndex          | inclusion position, receipt cross-check                     | A    | exact decimal string, numeric ordering within block                                   | no       |
| blockTimestamp            | inclusion block timestamp                                   | A    | exact decimal string, UTC Unix seconds                                                | no       |
| receiptStatus             | receipt outcome                                             | A    | string, success or reverted; neither filtered by default                              | no       |
| schemaVersion             | extractor dictionary version                                | A    | string, initially 1                                                                   | no       |

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

### Automatic PDF report

When `pdf` is enabled, the extraction command writes `report.pdf` in outputDir, using pdf-lib
inside the TypeScript app; no Python or external PDF service is required. The
English report contains network and inclusive block range, committed coverage and
completion state, transaction/part counts, gasUsed total/min/max/mean/median,
success/revert counts, configured filters, recipient/selector group statistics,
field interpretation, and the first 20 transactions in numeric block order.
The sample is explicitly bounded; the full dataset remains in Parquet. Integer
statistics stay exact through BigInt; means/medians round to two decimal places.
No RPC URLs, credentials or model performance claims appear in the report.

The PDF is atomically replaced at successful completion, including a completed
resume or a zero-match run. After extraction errors, a best-effort incomplete
report reflects only durable checkpointed rows. A failed PDF write is reported as
an error while preserving committed Parquet/checkpoint state; rerunning the same
command regenerates it. Report generation does not change dataset selection or
the version-1 row schema. No timestamp or private local path is embedded.

PDF verification (2026-10-19): build and typecheck passed; the full offline suite
passed 136 tests across 13 files. Tests cover exact statistics, grouping, empty and
incomplete runs, pagination, sample limits, privacy, manifest consistency, failed
PDF writes and regeneration on resume. The compiled CLI fixture also opens the
generated PDF. A report from the 11 existing USDC rows was rendered and visually
reviewed, along with empty and long-selection cases, without making new RPC reads.

### Loading Parquet

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
files = manifest.get("outputs", {}).get("parquetFiles", [part["file"] for part in manifest["parts"]])
if not files:
    raise ValueError("Enable parquet in outputFormats and rerun the extractor")
df = pd.concat([pd.read_parquet(run / filename) for filename in files], ignore_index=True)
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

To inspect JSON without a Parquet engine:

```python
import json
from pathlib import Path

rows = json.loads(Path("data/extractions/usdc-example/transactions.json").read_text())
for row in rows:
    print(row["transactionHash"], int(row["gasUsed"]))
```

## Durable runs and resume

Use one output directory per selection and one writer per run. Deterministic part
names encode inclusive batch bounds. Each part is finished, file-synced, closed,
and atomically renamed before the checkpoint is file-synced and atomically replaced.
Directory entries are also synced on POSIX; Windows cannot fsync directory handles,
so guarantees target process interruption rather than hardware power-loss recovery.
Temporary files end in .tmp. A crash before checkpoint replacement replays/replaces
the batch output without advancing past it. Checkpointed batch size is reused even
if the CLI setting changes. Empty batches create zero-row durable parts and advance
their block boundary; exported empty Parquet parts retain the full schema.

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
Parquet files named in manifest.outputs.parquetFiles. Complete means every requested block is committed,
including a valid zero-match run. Neither checkpoints nor manifests contain RPC URLs.
Do not edit/check in generated run state. Custom configs and data/extractions are ignored.

## Code style and architecture

Prettier is installed as an exact development dependency. The root .prettierrc.json
defines two spaces, single quotes, semicolons, trailing commas, parenthesized arrow
parameters and a 100-column target. These formatting conventions are similar to
the [Airbnb JavaScript guide](https://github.com/airbnb/javascript); this is a
[Prettier](https://prettier.io/docs/options) configuration, not the full Airbnb
ESLint ruleset. .editorconfig keeps editor whitespace consistent. Generated files,
dependencies and OpenSpec planning artifacts are excluded from formatter scope.

```sh
npm --prefix extractor run format
npm --prefix extractor run format:check
npm --prefix extractor run check
```

`check` runs formatting verification, typecheck, build and the full test suite.
It builds the compiled CLI before integration tests, preventing tests against stale
compiled code. The CLI remains procedural composition of application services.

| Component                                                      | Responsibility                                                                     |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| ConfigurationLoader                                            | Resolve YAML files relative to the invocation directory and validate configuration |
| RpcClientFactory / RPCManager                                  | Create read-only viem adapters; isolate per-network health and fallback            |
| TransactionScanner                                             | Scan inclusive batches and validate direct-call transaction/receipt identities     |
| RowNormalizer                                                  | Convert matched observations into the selected network's version-1 rows            |
| ExtractionRunner                                               | Coordinate scanning, normalization, durable commits, resume and outputs            |
| CheckpointRepository                                           | Load/validate checkpoints; verify parts; commit a part before its checkpoint       |
| FileStore                                                      | Adapt the storage interface to atomic local-file replacement                       |
| SelectionIdentity / ManifestBuilder                            | Normalize selection identity and construct sanitized provenance                    |
| OutputManager                                                  | Select registered presentation strategies and obtain their output filenames        |
| ParquetOutputStrategy / JsonOutputStrategy / PdfOutputStrategy | Write each selected export through the same OutputStrategy contract                |
| ParquetCodec / PdfReportRenderer                               | Encapsulate Parquet encoding and paginated PDF rendering                           |

The presentation layer uses **Strategy**. OutputStrategy exposes a format,
filenames(checkpoint) and write(context). Each concrete strategy owns its export
logic. OutputManager accepts injected strategies, so a renderer can be replaced
without modifying ExtractionRunner. Its default write order remains Parquet,
JSON, PDF; the configured subset determines which strategies run.

CheckpointRepository uses the same Parquet codec for already-durable Parquet parts;
the Parquet strategy reuses them or exports internal JSON-state parts when Parquet
is enabled later. Output choices, persisted formats, fingerprints and CLI arguments
retain their existing behavior. Small stateless validation, ordering, statistics
and serialization functions remain pure rather than becoming artificial classes.

Tests use the class APIs directly and also exercise strategy replacement, omitted
strategies, duplicate registration, injected codecs and renderer failure. They retain
the existing precision, privacy, recovery and output-combination coverage.

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

Configurable-output verification (2026-10-19) additionally covers all seven nonempty
format combinations, the repository's explicit three-format default, JSON exactness
and zero-row output, exports regenerated from old Parquet checkpoints or internal
JSON state, format changes during incomplete runs, failed JSON writes, partial
committed snapshots and real CLI JSON-only extraction against local fixtures.
