# Spec Delta

## Purpose

Provide reproducible historical datasets of direct EVM transactions and their gas-consumption labels for academic machine learning experiments.

## ADDED Requirements

### Requirement: Network selection by name
The extractor SHALL accept an uppercase network name and resolve its chain ID internally. It SHALL support ETHEREUM, ETHEREUM_SEPOLIA, AVALANCHE, AVALANCHE_FUJI, POLYGON, and POLYGON_AMOY, with Avalanche referring to C-Chain. The user MUST NOT need to supply a numeric chain ID.

#### Scenario: Select a testnet
- **WHEN** an extraction selects ETHEREUM_SEPOLIA
- **THEN** the extractor resolves Sepolia and records its network name and chain ID in dataset provenance

#### Scenario: Unknown network
- **WHEN** an extraction selects an unsupported network name
- **THEN** it fails with a configuration error before extracting transactions

### Requirement: File-based RPC configuration
The extractor SHALL read a local YAML mapping of uppercase network names to nonempty ordered lists of HTTP or HTTPS RPC URLs. A single endpoint SHALL be represented by a one-element list. No RPC URL environment variable SHALL be required.

#### Scenario: Multiple RPC endpoints
- **WHEN** ETHEREUM maps to two valid URL entries and the extraction selects ETHEREUM
- **THEN** the RPC Manager monitors both endpoints and selects the healthy endpoint with the highest recently observed block height, using configured order only to break ties

#### Scenario: Missing or invalid endpoints
- **WHEN** the selected network is missing, its list is empty, or an entry is not a supported URL
- **THEN** extraction fails with a configuration error that does not disclose credentials

### Requirement: Bundled public RPC configuration
The repository SHALL include config/rpcs.public.yaml with nonempty ordered lists of public, credential-free HTTPS RPC endpoints sourced from Chainlist for all six supported networks. The CLI SHALL use it by default and accept an explicit alternative configuration path. Extraction SHALL NOT require querying Chainlist or registering with an RPC provider at runtime.

#### Scenario: Start with bundled endpoints
- **WHEN** a user selects a supported network without specifying an RPC configuration path
- **THEN** the extractor loads that network's bundled endpoint list without requiring environment variables, API keys, or a local endpoint file

#### Scenario: Use a custom endpoint file
- **WHEN** a user supplies an explicit local RPC configuration path
- **THEN** that file replaces the bundled endpoint mapping for the run without modifying the versioned public file

### Requirement: Public endpoint provenance and verification
Documentation SHALL record the Chainlist source and review date for bundled endpoints, explain manual replacement, and distinguish a listing from verified extraction support. Bundled lists SHALL contain no credential placeholders, API keys, duplicate URLs within a network, or WebSocket URLs. Unit tests SHALL validate their shape and network coverage offline; live availability checks SHALL remain separate.

#### Scenario: Check the bundled configuration offline
- **WHEN** unit tests run without network access
- **THEN** they verify all six network keys, nonempty unique HTTPS URL lists, and absence of credential-bearing entries or placeholders without querying Chainlist or any RPC

#### Scenario: Public endpoint cannot serve the selected range
- **WHEN** bundled endpoints time out, rate-limit requests, or cannot provide the required historical blocks and receipts
- **THEN** bounded recovery and incomplete-run behavior apply, and the user can supply another RPC configuration without changing the extraction selection

### Requirement: RPC identity and bounded recovery
The extractor SHALL check each endpoint's reported chain ID before using it for extraction. It SHALL exclude mismatched endpoints, retry transient failures with bounded backoff, and select another healthy endpoint by descending observed block height on exhaustion or invalid data. Exhausting eligible endpoints SHALL fail the run without marking unfinished blocks complete or reporting success.

#### Scenario: Endpoint belongs to another network
- **WHEN** an endpoint configured for ETHEREUM reports Polygon's chain ID
- **THEN** no extraction data from that endpoint is accepted and the RPC Manager selects a healthy endpoint belonging to Ethereum

#### Scenario: Endpoint failure and fallback
- **WHEN** the active endpoint exhausts retries after rate limiting or a transient connection failure
- **THEN** extraction attempts the healthy eligible endpoint with the highest recently observed block height

### Requirement: Per-network read-only RPC Manager
The extractor SHALL access configured endpoints through a manager scoped to the selected network. It SHALL retain each endpoint's observed head height, health, and observation time, refreshing observations at startup and at a configurable interval during active extraction. Failed probes SHALL NOT prevent use of other healthy endpoints. The manager SHALL perform read operations only and SHALL NOT submit or broadcast transactions.

#### Scenario: Independent network state
- **WHEN** an Ethereum manager monitors its configured RPC endpoints
- **THEN** it selects only Ethereum endpoints and does not use heights or health observations from another network

#### Scenario: One probe does not respond
- **WHEN** one endpoint times out during head monitoring and another returns a valid head within the probe timeout
- **THEN** the manager can use the healthy endpoint without requiring the failed probe to succeed

### Requirement: Freshness-based endpoint selection
For each new extraction read, the manager SHALL prefer the healthy endpoint with the highest head from its current observations, breaking ties by configuration order. Expired observations SHALL be refreshed before selection. Endpoints below the requested block SHALL be ineligible for that request. New observations SHALL permit switching to a more up-to-date endpoint and re-admitting recovered endpoints.

#### Scenario: Freshest endpoint is not first in configuration
- **WHEN** two healthy endpoints report heights 100 and 105 and the request is for block 99
- **THEN** the manager chooses the endpoint reporting 105 even if it is second in configuration

#### Scenario: Ranking changes after refresh
- **WHEN** a later refresh shows that a previously lagging endpoint now has the highest healthy head
- **THEN** subsequent extraction reads prefer that endpoint

#### Scenario: No endpoint has the requested block
- **WHEN** every healthy endpoint reports a head below the requested block
- **THEN** bounded refresh/recovery applies and persistent unavailability fails the run without advancing its unfinished checkpoint

### Requirement: Validate data independently of head height
The extractor SHALL reject malformed responses, blocks inconsistent with the requested height, and transactions or receipts inconsistent with the selected block and transaction identities. Such responses SHALL trigger fallback without committing affected data. A higher reported head SHALL NOT bypass validation or be documented as proof of correctness or historical data availability.

#### Scenario: Highest-head endpoint returns invalid data
- **WHEN** the preferred endpoint returns a receipt with a mismatched transaction hash or block hash
- **THEN** no affected row is committed and the extractor retries the unresolved read through another eligible endpoint

#### Scenario: Highest-head endpoint lacks historical data
- **WHEN** the preferred endpoint cannot return a requested historical block despite reporting a newer head
- **THEN** the manager attempts another healthy endpoint capable of reaching that height before failing the unresolved batch

### Requirement: Bounded direct transaction discovery
The extractor SHALL accept one or more contract addresses and an inclusive historical block range for one network per run. It SHALL select only transactions whose top-level recipient matches a configured address. It SHALL reject malformed addresses or invalid ranges and SHALL NOT discover internal calls or router-mediated operations.

#### Scenario: Several selected contracts
- **WHEN** a block contains direct transactions to two configured contracts and one unrelated contract
- **THEN** only transactions to the two configured contracts are eligible

#### Scenario: Internal interaction is outside scope
- **WHEN** a transaction targets an unconfigured app that internally calls a configured contract
- **THEN** that transaction is excluded

### Requirement: Optional function filters
Each contract configuration SHALL optionally specify canonical function signatures or four-byte selectors. The extractor SHALL match any listed selector against the transaction's top-level calldata. Missing filters SHALL impose no function restriction; explicit empty lists or malformed entries SHALL be rejected. Bare function names SHALL NOT be accepted as signatures.

#### Scenario: Restrict a contract to a function
- **WHEN** a contract has one configured signature and two direct transactions invoke different selectors
- **THEN** only the transaction matching the selector derived from the configured signature passes the function filter

#### Scenario: No function restriction
- **WHEN** a contract has no function filter
- **THEN** all direct transactions to it within the range remain eligible, including empty calldata

### Requirement: Optional event topic filters
Each contract configuration SHALL optionally specify a nonempty list of 32-byte event signature topics. A direct transaction SHALL pass when its receipt contains at least one log emitted by that contract with topic0 in the list. Function and topic filters SHALL combine with AND. Without a topic filter, receipt status SHALL NOT exclude a transaction.

#### Scenario: Combine function and event filters
- **WHEN** both filters are configured and a transaction matches the function but has no matching event log from the selected contract
- **THEN** it is excluded

#### Scenario: Retain failed transactions without event filtering
- **WHEN** a matching direct transaction reverted and no event topic filter is configured
- **THEN** it is retained with its receipt gasUsed as the label and its status as audit metadata

### Requirement: Learning dataset with explicit field roles
The extractor SHALL write Parquet rows with a documented schema separating pre-execution feature candidates, gasUsed as the target, and audit/provenance fields. It SHALL preserve integer precision and include transaction identity, network identity, and block ordering. Receipt outcomes and actual inclusion-block context SHALL NOT be listed as eligible pre-execution features.

#### Scenario: Receipt supplies a label only
- **WHEN** a transaction and its receipt are exported
- **THEN** the row contains gasUsed as the target and receipt status as audit metadata, neither in the pre-execution feature list

#### Scenario: Preserve values and chronology
- **WHEN** a transaction value exceeds JavaScript's safe integer range
- **THEN** its exported value remains exact and its chain ID, transaction hash, block number, and transaction index permit identification and chronological ordering

### Requirement: Required pre-execution transaction fields
Each row SHALL contain from, to, type, nonce, value, gasLimit, input, gasPrice, maxFeePerGas, maxPriorityFeePerGas, and accessList. Fee fields SHALL represent submitted transaction terms, with inapplicable fields null. Access lists SHALL preserve ordered addresses and storage keys, with absent lists normalized to empty lists. These fields SHALL be documented as feature candidates, not an automatically selected model input set.

#### Scenario: Dynamic-fee transaction
- **WHEN** a type-2 transaction is extracted
- **THEN** maxFeePerGas and maxPriorityFeePerGas preserve its submitted caps, gasPrice is null, value is expressed in native-currency base units, and gasLimit is expressed in gas units

#### Scenario: Legacy transaction
- **WHEN** a legacy transaction is extracted
- **THEN** gasPrice preserves its submitted price in wei per gas, dynamic-fee fields are null, and an absent accessList becomes an empty list

### Requirement: Required calldata-derived fields
Each row SHALL contain functionSelector, calldataBytes, calldataZeroBytes, calldataNonzeroBytes, accessListAddressCount, and accessListStorageKeyCount, derived only from submitted input and accessList. The selector SHALL be null when input has fewer than four bytes. Counts SHALL describe the complete calldata, including the selector when present.

#### Scenario: Deterministic input features
- **WHEN** input contains four selector bytes and additional argument bytes
- **THEN** functionSelector equals the first four bytes and calldataZeroBytes plus calldataNonzeroBytes equals calldataBytes

#### Scenario: Short calldata
- **WHEN** input contains fewer than four bytes and no function filter is configured
- **THEN** functionSelector is null and byte counts still describe the complete input

### Requirement: Required target and audit fields
Each row SHALL contain gasUsed from the receipt as its target, chainName as a categorical feature candidate, and chainId, transactionHash, blockNumber, blockHash, blockTimestamp, transactionIndex, receiptStatus, and schemaVersion as audit fields. Audit fields SHALL NOT enter the default feature allowlist. Missing receipts SHALL be treated as incomplete extraction, not as zero gas or a silently omitted row.

#### Scenario: Inspect a training observation
- **WHEN** a dataset row is read
- **THEN** its transaction and network can be identified, its block order reconstructed, and its gasUsed traced to a receipt without treating status or actual inclusion time as pre-execution features

#### Scenario: Receipt temporarily unavailable
- **WHEN** a selected transaction's receipt remains unavailable after bounded recovery
- **THEN** the run reports incomplete extraction and does not commit progress past that unresolved batch

### Requirement: Versioned data dictionary
Documentation SHALL define every exported field's name, source, role, type, units or encoding, nullability, and derivation. The schema SHALL use lowercase hexadecimal for addresses and byte strings, exact decimal strings for EVM integer quantities, UTC Unix seconds for blockTimestamp, and integer counts for derived lengths. The manifest SHALL identify the schema version and explicit feature, target, and audit lists.

#### Scenario: Prepare data for training
- **WHEN** a downstream notebook loads the exported dataset and its manifest
- **THEN** it can identify gasUsed as the target, select only eligible feature candidates, interpret null fee fields, and parse exact quantities without using transaction hashes, block outcomes, or receipt data as predictors

### Requirement: Initial predictor rationale
The data dictionary SHALL identify chainName, to, and calldataBytes as initial predictor candidates, plus functionSelector, calldataNonzeroBytes, value, and accessListStorageKeyCount. It SHALL explain their hypotheses, categorical encoding needs, and limitations without promising predictive value. The nonzero-byte ratio SHALL be derivable from exported counts, with zero for empty calldata.

#### Scenario: Evaluate additional predictors
- **WHEN** an experiment prepares the initial candidate set
- **THEN** its documentation explains function identity, calldata composition, native transfer value, and declared access-list keys, and notes that constant or redundant fields can be dropped during preprocessing

### Requirement: Checkpointed and deduplicated extraction
The extractor SHALL process bounded block batches and persist progress only after their output is durable. Repeating or resuming the same extraction SHALL yield at most one row per chain ID and transaction hash. Checkpoints SHALL identify the network, range, contract filters, schema version, and completed block boundary, and incompatible resumes SHALL be rejected.

#### Scenario: Interrupted output commit
- **WHEN** extraction stops after writing a batch but before saving its checkpoint
- **THEN** resuming does not duplicate its rows and does not skip uncommitted blocks

#### Scenario: Configuration changes before resume
- **WHEN** a checkpoint is reused with a different network, range, or selection filter
- **THEN** the extractor rejects the resume and requests a separate output location or the original selection

### Requirement: Reproducibility and configuration privacy
The extractor SHALL emit a manifest containing the normalized selection, schema and field roles, block boundaries, row count, and completion state, excluding RPC URLs and credentials. Documentation SHALL explain retries, checkpoints, direct-call scope, and event-filter selection bias. Custom local RPC configuration and generated datasets SHALL remain outside version control; credential-free bundled public endpoints SHALL be versioned.

#### Scenario: Event-selected dataset
- **WHEN** extraction uses event topic filtering
- **THEN** the manifest records that filter and documents that reverted transactions without persisted logs are excluded by that selection

#### Scenario: Publish configuration examples
- **WHEN** users follow the documented setup
- **THEN** the bundled public file contains usable credential-free URLs, custom endpoint examples contain placeholders, and local configuration, datasets, and checkpoints are ignored by Git
