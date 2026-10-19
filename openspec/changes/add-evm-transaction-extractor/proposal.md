# Proposal

## Why

Atlas GasNet needs reproducible historical transaction data to train and evaluate its academic gas-consumption predictor. The extractor should support configurable EVM networks without turning the project into a blockchain indexing platform.

## What Changes

- Add a TypeScript/viem extractor for direct transactions to one or more configured contracts within a bounded block range.
- Select networks by uppercase names, including Ethereum, Avalanche C-Chain, Polygon, and their selected testnets; resolve chain IDs internally.
- Ship Chainlist public RPC lists and optional local configuration. Add a read-only RPC Manager per network, monitoring block heights and selecting the freshest healthy endpoint with bounded recovery.
- Support optional per-contract function signatures/selectors and event topic filters, with documented dataset selection effects.
- Produce deduplicated Parquet data separating pre-execution feature candidates, the `gasUsed` label, and provenance; resume safely with checkpoints.
- Define a versioned data dictionary with network, recipient, calldata size/composition, function selector, native value, and access-list counts as candidate predictors, plus field roles and encodings.
- Document setup, configuration, data semantics, and limitations under [issue #1](https://github.com/brianUtn98/atlas-gasnet/issues/1).

## Capabilities

### New Capabilities

- `evm-transaction-extraction`: Configurable historical extraction of direct EVM transactions and receipts into reproducible learning datasets.

### Modified Capabilities

None.

## Impact

Introduces the Node/TypeScript extraction package, public RPC configuration, local-file exclusions, and extractor documentation. Existing documentation must distinguish multi-network extraction support from the initial Ethereum Mainnet experiment. No model training, internal-call tracing, router discovery, real-time monitoring, or cross-chain analytics is included.
