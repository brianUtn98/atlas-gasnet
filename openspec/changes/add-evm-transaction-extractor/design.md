# Design

## Context

See proposal.md for motivation and specs/evm-transaction-extraction/spec.md for behavior. The repository currently has no extraction package or tests. README.md and docs/PROJECT.md describe an Ethereum Mainnet experiment; this change broadens extraction configuration without broadening the initial training experiment. A design is warranted by new dependencies, the dataset contract, and checkpoint semantics.

## Goals / Non-Goals

**Goals:** A small local CLI, deterministic selection, exact-value exports, and a documented boundary between candidate inputs and execution results.

**Non-Goals:** A general blockchain indexer, automatic function-argument decoding, state reconstruction, internal-call tracing, or automatic model feature selection. Supporting testnets does not imply combining their observations with mainnet training data.

## Decisions

### Local configuration and network registry

Use a TypeScript package under extractor/ with viem, a YAML parser, and a maintained Parquet writer selected during implementation. Keep configuration, RPC access, extraction, row normalization, and persistence as small modules rather than separate services.

Ship config/rpcs.public.yaml as the default endpoint map and use config/extraction.yaml for chain, contracts, inclusive fromBlock/toBlock, output directory, and bounded batch/retry settings. Accept an optional explicit RPC configuration path, such as config/rpcs.local.yaml; that file replaces the default mapping for the run, without implicit merging. Version the public endpoint file and placeholder custom examples, and ignore custom local endpoint files. No API key, endpoint environment variable, or local RPC file is required to use the bundled configuration.

Curate a small ordered list for each of the six networks from [Chainlist](https://chainlist.org/) and its [RPC JSON listing](https://chainlist.org/rpcs.json), rather than downloading the complete registry or adding runtime discovery. Select credential-free HTTPS URLs without placeholders, tokens, embedded credentials, or duplicate entries; prefer two endpoints per network where available. Record the source network pages and review date in comments or docs/extractor.md, keeping the YAML body a simple name-to-list mapping. Refresh manually when needed. Listing review establishes provenance, not guaranteed uptime or historical coverage; before claiming an endpoint was verified, separately check chain identity plus a full historical block and its transaction receipt in the intended range, and record results or the fact that no live verification ran. No automatic updater or extra blockchain infrastructure is included.

Map ETHEREUM/mainnet, ETHEREUM_SEPOLIA/sepolia, AVALANCHE/avalanche, AVALANCHE_FUJI/avalancheFuji, POLYGON/polygon, and POLYGON_AMOY/polygonAmoy to viem/chains definitions. Check getChainId before using any endpoint. Use an explicitly supplied HTTP transport so no default public endpoint is selected accidentally. Unknown names fail rather than guessing a network from a URL.

Proposed operational defaults: 100 blocks per batch, sequential extraction reads, and at most three retries per transiently failing request with exponential backoff. Honor bounded Retry-After when supplied; sanitize errors to report endpoint indexes rather than credential-bearing URLs. These are defaults, not throughput commitments.

### Read-only RPC Manager per network

Introduce a small RPCManager interface between extraction and viem clients. Its responsibilities are refreshing endpoint health/head observations, selecting an eligible endpoint for a requested block, executing a validated read, and exposing a sanitized health snapshot for diagnostics. Construct one manager for the selected network from the configured list, allowing any positive number of endpoints. Keep endpoint clients and their observed head, checkedAt, health, and retry/cooldown state internal. The interface exposes no signing, sending, or transaction-broadcast method.

Probe network identity and latest block height at startup, with bounded concurrency and a timeout per endpoint; a failed probe must not block the run indefinitely. Refresh observations during active extraction when the configured healthRefreshIntervalMs expires (proposed default 30 seconds), before selecting an endpoint for the next read. Coalesce overlapping refresh requests. A request-driven refresh is sufficient; do not add a standalone monitoring service or background daemon. A probe timeout of 5 seconds is a proposed configurable default. This interval describes observation freshness, not guaranteed blockchain freshness.

For each new read, rank currently healthy endpoints by descending observed head height. Break ties by configuration order. Require an observed head at least as high as the requested block. Never select using expired observations; refresh first. A newer snapshot may change the preferred endpoint. An endpoint with a timeout or transient failure becomes temporarily unavailable for selection; probe it again on a later refresh so it can recover. Preserve bounded recovery when all endpoints fail or lag the requested block. This replaces the original configuration-order primary/fallback policy; plain round-robin and broadcasting extraction requests are unnecessary.

Head height is a routing heuristic, not data validation or consensus. Validate block number/hash and transaction/receipt identities regardless of endpoint rank. Invalid payloads immediately disqualify that endpoint for the current unresolved read; transient failures use bounded retry before trying the next eligible endpoint in head order. Do not loop back to an already rejected endpoint in the same attempt cycle. A node may have the newest head and still lack historical data, so a missing historical block/receipt must permit fallback. Keep the selected block hash as the consistency anchor when reads switch endpoints; discard inconsistent results rather than combining them into a row. A later health refresh may re-admit a recovered endpoint. Keep diagnostics out of ML features and manifests free of endpoint URLs. No quorum voting or automatic canonical-chain reconciliation is included in this PoC.

### Discover direct transactions by block

Read blocks with full transactions, match recipient addresses, then apply per-contract function filters before fetching receipts. Accept canonical signatures and selectors in one functions list, normalize them to selector sets, and reject duplicate contract entries. No function filter means no calldata restriction. Optional eventTopics lists match receipt logs from the selected address by topic0; list entries combine with OR, while function and event filters combine with AND.

Scanning blocks is slower than indexed provider APIs but requires no additional service and preserves failed direct calls. Event filtering never expands discovery to transactions addressed to other contracts. Receipts must agree with transaction/block identity before rows are accepted. Work on fixed historical ranges; verify the last committed block hash on resume and stop on disagreement rather than implementing reorganization recovery.

### Version 1 dataset dictionary

One row represents one selected transaction, keyed by (chainId, transactionHash). Use flat Parquet columns. The table defines the initial dictionary; implementation documentation at docs/extractor.md must reproduce its field semantics and physical schema.

| Fields | Source and role | Encoding, units, nullability |
| --- | --- | --- |
| from, to | Transaction; candidate categorical inputs | Lowercase 20-byte hex addresses; non-null because contract creation is not selected |
| type | Transaction; candidate categorical input | Non-null integer transaction type, normalized from viem's named representation |
| nonce | Transaction; candidate input | Non-null exact decimal string; sender sequence number |
| value | Transaction; candidate input | Non-null exact decimal string; native-currency smallest units (18 decimals on the initial networks) |
| gasLimit | Transaction gas field; candidate input | Non-null exact decimal string; gas units, not gas consumed |
| gasPrice | Submitted fee for legacy and access-list transactions; candidate input | Exact decimal string in wei per gas; null for dynamic-fee transaction types, even if mined RPC responses expose a computed gasPrice |
| maxFeePerGas, maxPriorityFeePerGas | Submitted dynamic fee caps; candidate inputs | Exact decimal strings in wei per gas; null when not applicable |
| input | Transaction; raw candidate input | Non-null lowercase hex bytes; empty input is 0x |
| accessList | Transaction; raw candidate input | Non-null canonical JSON string of ordered address/storageKeys entries; absent list is []; hex values lowercase |
| functionSelector | First four input bytes; candidate categorical input | Lowercase four-byte hex; null if input has fewer than four bytes; does not imply a decoded function name |
| calldataBytes, calldataZeroBytes, calldataNonzeroBytes | Entire input bytes; derived candidates | Non-null integer byte counts; empty input yields zeros; zero/nonzero counts sum to total |
| accessListAddressCount, accessListStorageKeyCount | Submitted access list; derived candidates | Non-null integers; count entries and all storage-key entries respectively, preserving duplicates in counts |
| gasUsed | Receipt; target | Non-null exact decimal string in gas units |
| chainName | Registry, verified against RPC; candidate categorical input | Non-null uppercase network name |
| chainId | Registry, verified against RPC; audit | Non-null exact decimal ID string |
| transactionHash, blockHash | Transaction/block, cross-checked with receipt; audit | Non-null lowercase 32-byte hex |
| blockNumber, transactionIndex | Inclusion position; audit/chronological split | Non-null exact decimal strings; compare numerically when ordering |
| blockTimestamp | Inclusion block; audit/chronological split | Non-null exact decimal string containing UTC Unix seconds |
| receiptStatus | Receipt; audit | Non-null success or reverted; no default success-only filter |
| schemaVersion | Extractor; audit | Non-null string, initially 1 |

The initial candidate set includes chainName, to, and calldataBytes, plus these four hypotheses:

- functionSelector distinguishes operations within a contract; encode categorically in combination with network and recipient, not as an ordinal integer.
- calldataNonzeroBytes captures calldata composition in addition to its size. Preprocessing can use nonzeroBytes / calldataBytes, defined as zero for empty input. Zero bytes and nonzero bytes have different gas charges; the counts are not evidence of EVM operations executed. Do not include total, zero count, and nonzero count as independent signals without considering their exact dependency.
- value captures native currency sent with the call, which can change execution paths. It is not an ERC-20 amount: a USDC amount generally lives in input, so value may be constant zero for a Circle-only dataset.
- accessListStorageKeyCount captures declared storage keys, which participate in gas accounting. It is not the actual number of storage accesses. Absent lists yield zero, so the feature may be constant for the chosen sample.

These are testable hypotheses, not a guaranteed improvement. Report variation and retain or drop candidates based on the later ML experiment. The extractor also preserves the dictionary's other candidate fields for controlled experiments. For a single-network experiment chainName will be constant; network differences in monetary fees must not be confused with differences in gasUsed. Do not pool mainnets and testnets automatically.

The candidate list is an eligibility boundary, not a promise that raw strings or every field should enter the MLP. Downstream preprocessing must explicitly choose, encode, and scale inputs; hashes, ordering, receipt outcomes, and schema metadata are excluded from the default feature allowlist. No ABI-decoded arguments, sender state, receipt logs, effectiveGasPrice, cumulativeGasUsed, or actual block gas totals are exported as model inputs. Function names can be inferred from the configured signatures later; selectors remain the stable extracted field. Gas-price fields are preserved for optional experiments but are not proposed as primary indicators of computational work. gasLimit is a pre-execution cap and may reflect an upstream estimator; analyze it separately rather than equating it to consumption.

Protocol references for implementation documentation: [transaction fields](https://ethereum.org/developers/docs/transactions/), [access-list accounting](https://eips.ethereum.org/EIPS/eip-2930), and [calldata accounting](https://eips.ethereum.org/EIPS/eip-7623).

### Durable local output

Write deterministic Parquet batch parts beneath one run directory, ordered by blockNumber and transactionIndex. Deduplicate by row key. Write each part to a temporary file, finish and close it, atomically rename it, then atomically replace the checkpoint. A crash between part and checkpoint commits replays and replaces the same part, not appends duplicate rows. Persist the original batch layout so resume remains deterministic. Empty batches advance progress without fabricating rows.

Store a versioned normalized selection fingerprint with the network, range, contract addresses, normalized filters, and schema. RPC endpoint changes do not invalidate a checkpoint; selection changes do. A missing receipt or unreadable block aborts the batch after bounded recovery. Record the last committed block/hash, next block, and completed parts. Generate the manifest from committed parts, with row count and complete/incomplete state, so it can be reconciled after interruption. Never report complete before every requested block is committed. A zero-match run is valid and exposes the schema and zero row count.

The manifest includes the dictionary's feature/target/audit lists, normalized filters, range, and schema version, but no RPC URLs. Keep custom local endpoints, dataset directories, temporary outputs, and checkpoints untracked; the credential-free bundled public configuration is versioned. CSV export is deferred: Parquet is the primary handoff to Python/Colab.

## Risks / Trade-offs

- Block scanning costs RPC calls -> bounded ranges and early recipient/selector filtering; avoid adding an indexing service to the academic PoC.
- Public endpoints may rate-limit, lag, return invalid data, or lack historical data -> monitored head-based routing, independent data validation, bounded fallback, explicit incomplete runs, and optional local configuration. A high head or Chainlist listing does not prove correctness.
- Event filtering selects on execution outcomes -> record filters and selection bias; do not turn event presence into a pre-execution feature.
- High-cardinality addresses and raw calldata need preprocessing -> document them as candidates and preserve originals; model encoding belongs to the later ML workflow.
- Chains, testnets, contract upgrades, and transaction types have different distributions -> record provenance, do not claim a pooled dataset is comparable, and keep the first experiment scoped to Ethereum Mainnet.
- Decimal strings require numeric conversion in Python -> document parsing and require exact-value Parquet round-trip verification, including values above 2^53.
- Checkpoint/part inconsistencies -> deterministic replacement, resume fixtures around commit boundaries, and no silent skipping after RPC exhaustion.

## Migration Plan

Add the package, public endpoint configuration, and examples without changing existing datasets. Update README.md and docs/PROJECT.md during implementation to distinguish supported extraction networks from the chosen experiment. Existing OpenSpec context remains a reference to that initial experiment. No data migration is needed. Rollback removes the new extraction package, bundled configuration, and documentation changes; generated local outputs remain user-owned.
