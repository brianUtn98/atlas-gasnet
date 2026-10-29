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
Defaults: batchSize=100, rpcConcurrency=8 (allowed 1–32), retries=3 (allowed 0–10), healthRefreshIntervalMs=30000,
probeTimeoutMs=5000. Batch size and timeouts must be positive bounded integers.
Additional tuning defaults: rpcAdaptiveConcurrency=true, rpcBatchSize=1 (1–32),
rpcBatchWaitMs=2 (0–100), rpcBalanceCacheSize=4096 (0–100000). The repository PoC
selections keep batch size 1: live comparisons found individual HTTP requests
faster on the current public provider. Size 3 is a supported opt-in alternative.

## Output formats

Choose exports in the extraction YAML, for example:

```yaml
outputDir: data/extractions/usdc-enriched-v3
outputFormats: [parquet, pdf, json]
```

The versioned repository configuration explicitly enables all three; omitted
outputFormats also defaults to all three. Any nonempty subset is accepted, such
as `[json]` or `[parquet, pdf]`. Unknown, uppercase, duplicate, empty or non-list
values fail validation. There are no separate CLI format flags.

- `parquet`: deterministic `part-FROM-TO.parquet` batches with the version-3 schema.
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
at startup and request-driven refreshes every 30 seconds (configurable). Identity
and head probes run independently under the same global concurrency limit as
data requests, each with a 5 second configurable timeout. Overlapping
refreshes coalesce. Unexpired healthy observations rank by descending head, then
configuration order. Nodes below the requested height are excluded. Failed nodes
can recover on later refreshes. The interface exposes block, receipt and historical
ERC-20 balance reads only.
Reads retry transient errors up to retries times with 250 ms exponential backoff,
capped at 30 seconds; structured Retry-After seconds/dates are honored up to that
cap. Exhaustion or invalid historical data falls back in head order. An endpoint
rejected for a read is never revisited in that read. A null historical receipt is
treated as temporarily unavailable and uses the normal request retry budget.
Diagnostics include operation, height, transaction hash for receipts, endpoint
index, validation reason and structured HTTP/RPC codes, without provider messages.
Structured authorization (401/403) and invalid/unsupported request errors
(-32600/-32601/-32602) skip retries for that endpoint/read. Provider Retry-After
cooldowns apply to queued calls too, including historical state requests. An
already in-flight request cannot be recalled by a later cooldown response.
Head freshness is a routing heuristic: independently validate historical block,
transaction and receipt identities. A recent high head proves neither historical
coverage nor correctness. There is no quorum or automatic reorganization repair.

Exhausted RPC reads trigger up to `batchRetries=3` additional batch attempts with
`batchRetryDelayMs=5000` exponential delays, capped at 60000 ms per delay. Set
`batchRetries: 0` to disable this layer. Each attempt discards uncommitted rows,
drains the failed scan's active workers and starts fresh at the same batch boundary.
Earlier committed batches are preserved; rows and receipts are never skipped.
These settings do not change checkpoint identity. Resume-anchor transport failures
use the same recovery policy; inconsistent anchor hashes stop the run.
Configuration, storage/output failures and exhausted authorization/unsupported
request errors do not receive batch retries. After recovery is exhausted, the CLI
exits with code 2 for recoverable RPC exhaustion, or code 1 for other failures.
`rpc_exhausted`, `batch_retry` and `failed` events retain safe failure details;
`rpc_summary` is emitted even when extraction fails.

The E3 PowerShell runner also retries exit code 2 from the durable checkpoint,
up to `-MaxStageRetries 2`, waiting `-RetryDelaySeconds 30` between restarts.
Native stderr is logged without bypassing exit-code handling on Windows
PowerShell. For example, resume only the unfinished stage with
`.\scripts\run-e3-extraction.ps1 -Phase Full -Stages unseen-contract`.
See [the E3 failure investigation](extraction-recovery.md) for the observed failure
and validation evidence.

## Concurrency and console progress

```yaml
rpcConcurrency: 8
rpcAdaptiveConcurrency: true
rpcBatchSize: 1
rpcBatchWaitMs: 2
rpcBalanceCacheSize: 4096
```

The default maximum is eight in-flight logical RPC requests per process, across all providers and
operations: health probes, blocks, receipts and historical balances. Set an integer
from 1 to 32; use 1 for sequential transport calls. Blocks are scanned concurrently
inside a batch, selected transaction workers overlap receipt retrieval and
enrichment, and independent sender/recipient balances are fetched together. Self
transfers reuse the sender request. A shared transaction-worker bound prevents
nested block workers from multiplying active transaction processing. All actual
network requests still share the global permit pool.

The HTTP transport retains its aborting timeout. A manager timeout does not release
the physical request's permit until the transport settles; queued permit waits are
also bounded. Worker pools drain in-flight work on failure before reconciliation.
Checkpoints remain sequential and atomic, with rows ordered by block/transaction
index regardless of response order. `batchSize` controls checkpoint boundaries,
not HTTP request batching. `rpcBatchSize` separately enables optional HTTP batching.

Changing `rpcConcurrency` does not change the selection fingerprint: rerun the
same command to resume an existing checkpoint. Each process owns its own limit;
four simultaneous CLI runs with concurrency 8 can create 32 logical RPC requests together.
Use one collection process at a time on the public PoC endpoint. Concurrency is a
maximum in-flight count, not a requests-per-second quota.

With `rpcAdaptiveConcurrency: true`, HTTP/RPC rate-limit signals, structured
Retry-After and manager timeouts halve the current limit (minimum 1), at most once
per second. Completed requests taking at least 75% of the timeout also trigger a
reduction. After at least 16 healthy completions and a one-second window, the limit
recovers by one, up to `rpcConcurrency`. Active requests drain naturally when the
limit falls; queued requests obey the reduced bound. Set the option to false for
a fixed limit. `rpc_concurrency` logs explain reductions/recovery. HTTP 429/503
headers survive even when the response contains a JSON-RPC error body.

`rpcBatchSize: 1` disables HTTP batching and is the default for unspecified
providers. Larger values coalesce reads for up to `rpcBatchWaitMs`; each logical
call still retains its permit until the transport settles. Responses are matched
by ID, validated for missing/duplicate/foreign IDs and checked per call. Partial
RPC errors do not repeat successful calls. An explicit batch rejection or known
provider batch-quota error automatically switches that endpoint to individual
HTTP requests for the rest of the process. HTTP 429/503 and ordinary server
errors keep their cooldown/retry behavior and do not trigger a request fan-out.
Fallback requests remain within the logical concurrency bound and drain on failure.

The public dRPC endpoint accepted batches of 3 on 2026-10-28 and rejected larger
ones with HTTP 500 / provider error 31. Size 3 reduced HTTP envelopes but was
slower than individual requests in the measured workload; PoC configs keep size 1.
Provider limits can change; the fallback handles rejection, and custom providers
can opt into their own verified size. Batching reduces HTTP envelopes, not
necessarily billable requests or provider compute. Large block responses can
also constrain practical batch size.

Live verification on 2026-10-28 scanned blocks 19000000–19000009 and produced
48 identical rows in all successful variants, including complete Parquet/JSON/PDF
exports. The previous configuration (4 requests, cache off) took 7.64–7.78 seconds;
the chosen 8-request configuration with cache and individual HTTP calls took
4.47–4.57 seconds (about 1.7x faster in that comparison). With batch size 3,
another pair took 4.37–4.94 seconds and 44–45 HTTP
envelopes instead of 116. A larger batch rejected by the public provider fell
back automatically with no lost rows or logical retries. These are short-range
measurements, not a guaranteed speedup over an entire historical extraction.

The ERC-20 enricher shares in-flight and completed balance reads inside each
batch, keyed by network, token, owner, reference height and the validated inclusion
block hash. A different block/hash never shares state. The cache stores exact
uint256 balances, including zero, and evicts failed promises so subsequent rows
can recover. `rpcBalanceCacheSize` bounds retained entries; settled least-recently
used entries are evicted first. Pending entries are not evicted; new reads bypass
the cache if all slots are pending. Zero disables caching. A new cache is created
for each batch, so memory stays bounded and no state is shared across runs.
`batch_committed` includes cache hits/misses/entries. These operational options
do not change the selection fingerprint or the published dataset schema.

The CLI prints timestamped progress with elapsed seconds. Intermediate scan,
enrichment and retry/wait updates are throttled to approximately once per second.
Start/resume, batch boundaries, confirmed checkpoints, export and completion are
printed immediately. `percent` describes durably committed block coverage;
`scannedPercent` describes blocks read and may be ahead of committed progress.
Rows/receipts within a batch are work in progress until `batch_committed`.
`complete` is emitted after the selected outputs finish. The final `rpc_summary`
includes logical attempts, retries, observed peak/current concurrency, average
request duration overall and per operation (probe/block/receipt/balance), cumulative queue wait, actual HTTP requests, batch envelopes
and fallback counts. Duration excludes queue wait; the cumulative queue counter
can exceed wall time because callers wait concurrently. Provider URLs,
raw exception messages, credentials and transaction calldata are never logged.

Example (illustrative counts and elapsed time):

```text
[2026-10-20T03:10:00.000Z] start elapsed=0.0s network=ETHEREUM fromBlock=19000000 toBlock=19001439 rpcConcurrency=4
[2026-10-20T03:10:02.000Z] scan elapsed=2.0s scannedBlocks=4 totalBlocks=1440 percent=0 scannedPercent=0.27 receiptsRead=8 committedBlocks=0
[2026-10-20T03:10:12.000Z] batch_committed elapsed=12.0s committedBlocks=25 totalBlocks=1440 percent=1.73 rows=100 nextBlock=19000025 failedEnrichments=0
```

## Selection and bias

Discovery scans both range endpoints and selects only top-level recipients; internal
calls, router interactions and event-only discovery are outside scope. Receipts must
match the selected transaction, block hash, height, position, sender and recipient.
Invalid responses trigger fallback while retaining that selected block hash. Missing
receipts fail the batch instead of skipping a row. Without topics, reverted direct
calls are retained. Topic filtering selects on execution outcomes: reverted calls
without persisted logs are excluded. Record this selection bias when training; event
presence and receipt status are never pre-execution predictors.

## Optional ERC-20 historical balances

Enable both options in a selection YAML to request historical state. Both default
to false and must be actual YAML booleans. The repository selection marks USDC as
ERC-20 and explicitly enables global enrichment. Omitted options still default to
false; no state calls are made while disabled.

```yaml
erc20BalanceEnrichment: true
contracts:
  - address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
    erc20: true
    functions: ['transfer(address,uint256)']
outputDir: data/extractions/usdc-state-study
```

Add network, fromBlock, toBlock and other output settings as in the repository
selection. An ERC-20 designation is an explicit user assertion, not automatic token
detection. Only selector `0xa9059cbb` with exactly two canonical ABI words is enriched.
The first word contains the token recipient and the second the uint256 amount in
token base units. `to` remains the token contract; `value` remains native currency.
Other functions and contracts are not enriched. Extra calldata bytes, missing words
and nonzero address padding fail enrichment rather than being guessed. Decoded
recipient is used internally and recoverable from `input`; `tokenAmount` exports
the exact decoded amount as a decimal string. `isZeroAmount` and `isSelfTransfer`
describe submitted calldata. They stay available when decoding succeeds even if
historical state fails or inclusion is block zero. All enrichment fields remain
null for disabled/non-applicable calls, except audit status/reason. Malformed
transfers have null calldata-derived fields too. `approve` and `transferFrom` remain
not applicable; there are no allowance columns or extra queries.

For inclusion block N > 0, the existing RPCManager sends `balanceOf(from)` and
`balanceOf(decodedRecipient)` as `eth_call` at the numeric tag N - 1. It never uses
`latest` or the end of block N. A self transfer reuses the same account read. Raw
results must be exactly 32 bytes; empty `0x`, malformed responses, errors and missing
archive state never become zero. Existing chain validation, timeouts, retries,
Retry-After handling and fallback apply. A failed historical-state read does not
establish that the endpoint cannot serve ordinary blocks or receipts.

The fixed failure policy is **record null and continue**. Every row has one status:

| stateEnrichmentStatus | stateEnrichmentReason                             | Meaning                                                                                                                              |
| --------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| not_applicable        | disabled, contract_not_enabled, or other_function | No state request; all state candidates and reference height null                                                                     |
| failed                | invalid_calldata                                  | Enabled transfer cannot be decoded; no state request or reference height                                                             |
| failed                | invalid_state_block                               | Inclusion block zero has no previous block; no state request or reference height                                                     |
| failed                | historical_state_unavailable                      | All recovery exhausted or state response invalid; attempted N - 1 and decoded calldata retained; all balance-derived candidates null |
| complete              | null                                              | Both balances available; ratio null only for zero sender balance                                                                     |

No partial balance is retained after either read fails. Codes never include external
error messages, URLs or credentials. General extraction failures (missing blocks or
receipts) still abort the unfinished batch. `manifest.complete` describes block
coverage, **not** enrichment success. PDF coverage counts show all three statuses;
JSON and Parquet retain status per row. Resuming preserves committed failed rows;
use a fresh output directory to attempt their enrichment again. Missingness must
be handled explicitly in future preprocessing, never filled with fictitious zeros.

`BeforeBlock` means **state at the end of the block before inclusion**, an
approximation to state immediately before the transaction. Earlier transactions
in the inclusion block may change either balance. `senderBalanceEqualsAmount`
compares the reference balance with the calldata amount; it does not guarantee the
transfer succeeded or emptied the sender, including for self transfers and zero
amounts. Indicators never use gasUsed, logs, receiptStatus or later state. Observed
differences of 17,100 or 4,800 gas do not automatically establish any specific cause.
No formula replaces or adjusts receipt-observed `gasUsed`.

`senderHasEnoughBalance` compares the sender's reference balance with `tokenAmount`
using exact integers. It is 1 when balance >= amount, including amount=balance=0;
it does not guarantee execution success. The existing balance-zero/equality flags
remain available alongside it. No new state reads are needed for these features.

`amountToSenderBalanceRatio` uses a **reduced exact rational string** `p/q`, with
decimal unsigned integer numerator and positive denominator, computed using BigInt.
For example amount=6, balance=9 yields `"2/3"`; zero amount and positive balance
yields `"0/1"`; equal positive values yield `"1/1"`. No Number conversion,
rounding, precision cap or clipping occurs, even for uint256 extremes. Balance zero
yields null for both 0/0 and positive/0, never a fake zero or infinity. A complete
row with sender balance `"0"` identifies this undefined ratio; a failed row with
null sender balance identifies unavailable state. The manifest records
`ratioEncoding: reduced_unsigned_rational_string` and `ratioZeroDenominator: null`
(the policy value is the string `"null"`, describing the row's actual null).

Before feeding a model, parse the ratio with arbitrary precision and explicitly
choose numeric precision/scaling; it is not a categorical feature or a JSON number.
For Python, `fractions.Fraction(row["amountToSenderBalanceRatio"])` preserves it
exactly; convert numerator and denominator using `decimal.Decimal` with an explicit
precision only at the model preprocessing boundary. Check for null first and keep
zero-denominator and missing-state masks from the balances/status. Very small
positive ratios remain distinct from zero in the exported data.

For a real prediction, decode the submitted call and query the same accounts at an
explicit, already-known reference block (for example the last known canonical block
at submission); record that height. The eventual inclusion block is unknown then.
Evaluate that reference-age/deployment mismatch separately, including within-block
effects. A balance measured after execution is audit information with outcome leakage,
not an eligible input for pre-execution estimation. No post-state is collected here.
Numeric block tags trust provider canonical history; the existing resume hash anchor
is retained, with no quorum, parent-hash pinning or reorganization repair.

Schema 3 adds these columns even with enrichment disabled. Old schema-1/2 checkpoints
are rejected before writes: select a fresh output directory instead of appending to
old parts. The shipped example now targets `usdc-enriched-v3`. Global enrichment and
per-contract ERC-20 options are fingerprinted, so changing either also requires a
new run. Output formats can still change on compatible resume. Manifests include
the enable flag, reference convention, failure policy, ratio encoding/zero policy
and approximation limitation.
The original USDC example was used as a schema/calldata reference; no live state
queries, expanded extraction or model training were performed for this change.

## Version 3 data dictionary

Rows are keyed by `(chainId, transactionHash)`. Hex is lowercase; decimal strings
are exact unsigned integers. All fields are required except the explicitly
nullable fields below. C = eligible pre-execution candidate, T = target, A = audit.
Candidates are an eligibility boundary, not automatic MLP inputs.

Schema-3 additions (C = eligible candidate, A = audit) are:

| Field                            | Source / derivation                                             | Role | Type / units                                                                                 | Nullable |
| -------------------------------- | --------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------- | -------- |
| tokenAmount                      | decoded transfer uint256                                        | C    | exact decimal string, token base units                                                       | yes      |
| isZeroAmount                     | decoded amount equals zero                                      | C    | INT32, 0 or 1                                                                                | yes      |
| isSelfTransfer                   | decoded recipient equals transaction sender (case-insensitive)  | C    | INT32, 0 or 1                                                                                | yes      |
| senderHasEnoughBalance           | reference sender balance >= decoded amount                      | C    | INT32, 0 or 1                                                                                | yes      |
| amountToSenderBalanceRatio       | decoded amount / reference sender balance                       | C    | exact reduced rational string p/q, dimensionless; null for zero balance or unavailable state | yes      |
| stateBlockNumber                 | inclusion height minus one, when a historical read is attempted | A    | exact decimal string, block height                                                           | yes      |
| senderTokenBalanceBeforeBlock    | balanceOf(transaction sender) at stateBlockNumber               | C    | exact decimal string, token base units                                                       | yes      |
| recipientTokenBalanceBeforeBlock | balanceOf(calldata recipient) at stateBlockNumber               | C    | exact decimal string, token base units                                                       | yes      |
| recipientBalanceWasZero          | reference recipient balance equals zero                         | C    | INT32, 0 or 1                                                                                | yes      |
| senderBalanceEqualsAmount        | reference sender balance equals calldata uint256 amount         | C    | INT32, 0 or 1                                                                                | yes      |
| stateEnrichmentStatus            | enrichment applicability/result                                 | A    | string enum documented above                                                                 | no       |
| stateEnrichmentReason            | sanitized missingness reason                                    | A    | string code documented above; null when complete                                             | yes      |

The existing `initialPredictors` list stays fixed; the nine enrichment
new candidates extend the manifest `features` allowlist. Reference height, status
and failure reasons are audit metadata and must not become model inputs implicitly.

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
| schemaVersion             | extractor dictionary version                                | A    | string, currently 3                                                                   | no       |

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
the version-3 row schema. No timestamp or private local path is embedded.

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
The type code, five derived counts and five transfer/balance indicators use INT32.
Nullable fields in the dictionary are OPTIONAL; other columns are REQUIRED.
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
| RowNormalizer                                                  | Convert matched observations into the selected network's version-3 rows            |
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

ERC-20 enrichment verification (2026-10-19): `npm --prefix extractor run check`
passed formatting, typecheck, build and all 235 deterministic tests in 17 files,
including 70 new state-enrichment/persistence cases and the extended compiled CLI
fixture. Coverage includes exact uint256 values and rational ratios, transfer flags,
zero denominators, calldata retained after state failure, missing archive state,
recovery, null policy, all status outcomes, JSON/Parquet/PDF output and schema-bound
resume rejecting schema-1/2 checkpoints before writes.
`openspec validate add-erc20-historical-balances --strict --json` and
`git diff --check` passed. Windows sandbox temporary-file replacement again returned
EPERM in disk/CLI tests; the full check passed outside the sandbox. No live RPC
extraction or model training ran; provider archive coverage remains unverified.

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
