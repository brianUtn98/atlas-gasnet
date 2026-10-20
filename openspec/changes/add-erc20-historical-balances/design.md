# Design

## Context

See proposal.md for motivation. The extractor already owns validated routing, exact quantities, output strategies and fingerprint-bound checkpoints. The USDC schema-1 example contains 11 transfers; it remains read-only reference data. This cross-cutting schema migration warrants a design.

## Goals / Non-Goals

**Goals:** Keep extraction sequential and use existing RPCManager recovery and output strategies.

**Non-Goals:** Transaction replay, traces, arbitrary ABI enrichment, caching infrastructure or gas formulas.

## Decisions

- Configuration: global `erc20BalanceEnrichment: true` plus per-contract `erc20: true`, both false when omitted. Validate actual booleans. Explicit designation avoids assuming selectors prove token semantics.
- An enrichment service runs between normalization and commit. Require exactly 68 bytes and canonical zero address padding; other functions are not applicable, malformed enabled transfers fail. Decode via exact hex/BigInt. A self transfer reuses one read for the same account.
- Add a typed balanceOf read to the existing factory and manager. Encode the fixed selector and owner ABI word and send eth_call with an explicit numeric block tag. Require exactly one 32-byte result; empty data is invalid rather than zero. Existing network checks, bounded requests, retry/fallback and error sanitization remain in force.
- Fixed policy: record nullable missing candidates and continue extraction after enrichment failure. Export `stateEnrichmentStatus` and `stateEnrichmentReason` as audit fields, with static codes. No partial balances survive failure; status complete requires both reads. Inclusion block zero fails without RPC. No provider error text is persisted. A completed dataset can contain failed enrichment; it does not claim complete state coverage.
- Schema 3 applies to all new runs, including disabled enrichment. Extend the shared column dictionary for JSON/Parquet and manifest roles. Include normalized global/per-contract options in the fingerprint. Reject v1/v2 instead of silently migrating or mixing rows. Persisted failed rows stay failed on resume; use a fresh directory to retry them.
- Export tokenAmount as an exact decimal string and isZeroAmount/isSelfTransfer as integer flags when enabled transfer calldata is valid, even when historical state is unavailable or inclusion is block zero. On non-applicable or malformed calls these are null. Add senderHasEnoughBalance from the reference balance comparison; it describes a snapshot, not execution success. Balance-derived values remain all-or-nothing on state failure.
- Encode amountToSenderBalanceRatio as a reduced unsigned rational string `numerator/denominator`, using BigInt Euclidean reduction without Number conversion, rounding or clipping. A zero denominator yields null, including 0/0; a complete row with sender balance "0" distinguishes this from unavailable state. Zero amount with positive balance yields "0/1". Prefer an exact rational over a float or fixed decimal that could collapse tiny positive ratios to zero. Record encoding/zero policy in the manifest and document explicit numeric preprocessing for models.
- Scope remains transfer only; approve/transferFrom calls stay not applicable. No allowance columns or queries, proxies, protocol versions, contract-specific logic or post-execution features are added.
- Add manifest policy/reference text and PDF coverage counts using committed rows. Preserve gasUsed and existing initial predictors; new candidates are eligible additions for future controlled comparison.

## Risks / Trade-offs

- Prior-block approximation misses earlier same-block activity -> document clearly; no balance depletion claim or causal claim for 17,100/4,800 gas differences.
- Numeric block tags depend on provider canonical history -> retain existing resume hash anchor; no quorum, parent-hash pinning or reorganization repair is added.
- Archive reads may be unavailable or costly -> opt-in, bounded recovery and explicit missingness; no live extraction during implementation.
- Real prediction cannot know the eventual inclusion block -> choose and record a known reference block at submission, measure this deployment mismatch separately.

## Migration Plan

Use a new output directory for schema 3. Keep old examples separate. Roll back by returning to the previous extractor and its separate schema-1/2 directories; no in-place conversion.
