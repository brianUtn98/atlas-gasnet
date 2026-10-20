# Proposal

## Why

Transaction calldata alone omits token state that may help predict receipt-observed gasUsed. Prepare a controlled future comparison using historical ERC-20 balances without training models or assuming a gas-accounting explanation.

## What Changes

- Add disabled-by-default historical balance enrichment for explicitly enabled ERC-20 contracts and canonical transfer calldata.
- Route balanceOf reads at inclusion block minus one through the existing validated RPC manager.
- Export exact tokenAmount, balances, transfer/state indicators and an exact amount-to-balance ratio, plus reference height, status and sanitized failure reason; retain receipt gasUsed unchanged.
- **BREAKING**: introduce row schema 3 and bind enrichment configuration to checkpoints; require a new output directory for schema-1/2 runs.
- Document missing-state policy, prediction-time availability and within-block limitations; add deterministic tests.

## Capabilities

### New Capabilities

- `erc20-historical-balances`: opt-in state candidates, historical RPC reads, failure semantics and compatible persistence.

### Modified Capabilities

None. The existing extractor capability remains in its original, unarchived change; its behavior is extended by this capability.

## Impact

Extractor configuration, RPC interfaces, enrichment, row schema, manifests, checkpoints, exports and English documentation. No new dependency, live extraction, model training or edits to existing example data.
