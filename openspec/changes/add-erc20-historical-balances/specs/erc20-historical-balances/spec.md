# Spec Delta

## Purpose

Provide auditable historical ERC-20 balance candidates for studying their contribution to gas-consumption prediction without changing observed labels.

## ADDED Requirements

### Requirement: Explicit opt-in and transfer decoding
Enrichment SHALL default to disabled. Only contracts explicitly configured as ERC-20 SHALL qualify. The recipient and uint256 amount SHALL come from canonical transfer(address,uint256) calldata, never tx.to or receipt results.

#### Scenario: Applicable call
- **WHEN** enrichment is enabled and an enabled contract receives canonical transfer calldata
- **THEN** the token recipient and exact amount are decoded from its two ABI words

#### Scenario: Inapplicable or malformed call
- **WHEN** enrichment is disabled, the contract is not enabled, or another selector is called
- **THEN** status is not_applicable and no state request occurs
- **WHEN** an enabled transfer has malformed calldata
- **THEN** status is failed with invalid_calldata and no state request occurs

### Requirement: Historical reads through validated routing
Balance reads SHALL use the existing network-validated, bounded retry/fallback routing at exactly inclusion block minus one. They SHALL reject malformed uint256 responses and SHALL NOT query latest or the inclusion block. Inclusion block zero SHALL fail enrichment without issuing a state read.

#### Scenario: Reference height
- **WHEN** a transfer is included in block N greater than zero
- **THEN** both balances are read at N minus one and stateBlockNumber records that decimal height

#### Scenario: Genesis and unavailable history
- **WHEN** inclusion is block zero
- **THEN** enrichment fails with invalid_state_block and null reference height
- **WHEN** all eligible RPCs fail after recovery or lack historical state
- **THEN** enrichment fails with historical_state_unavailable and retains the attempted reference height

### Requirement: Exact candidates and missingness
Rows SHALL export exact decimal senderTokenBalanceBeforeBlock and recipientTokenBalanceBeforeBlock, plus integer recipientBalanceWasZero and senderBalanceEqualsAmount. Status SHALL distinguish not_applicable, failed and complete. Incomplete enrichment SHALL set all four candidates null, retain the receipt label and record only sanitized reason codes. Partial balance results SHALL NOT be exported.

#### Scenario: Boundary values
- **WHEN** balances are zero, positive, equal or unequal to amount, including zero amounts, self transfers and integers above 2^53
- **THEN** complete candidates use exact unsigned arithmetic and indicators 0 or 1

### Requirement: Versioned durable output
Schema 3 SHALL describe candidates and audit roles in manifests and exports. Enrichment settings SHALL participate in the selection fingerprint. Schema-1/2 or differently configured checkpoints SHALL be rejected before writes. Completed resumes SHALL preserve committed enrichment results, including failed rows.

#### Scenario: Resume and exports
- **WHEN** a run resumes with the same schema and enrichment selection
- **THEN** JSON and Parquet preserve candidates, nulls, status and reference height without rescanning committed rows
- **WHEN** schema or enrichment settings differ
- **THEN** resume fails and requires a separate output directory

### Requirement: Methodological boundary
Documentation SHALL identify prior-block state as an approximation affected by earlier same-block operations. It SHALL explain prediction-time reference selection. The equality indicator SHALL NOT guarantee balance depletion. No candidate SHALL be inferred from gasUsed, logs, status or later results, and gas differences SHALL NOT automatically receive causal interpretations.

#### Scenario: Future prediction
- **WHEN** an experiment uses these variables
- **THEN** it records the available reference block, treats missingness explicitly and retains receipt gasUsed as the target without formula corrections

### Requirement: Transfer amount and calldata indicators
Enabled valid transfers SHALL export tokenAmount as an exact decimal string and isZeroAmount/isSelfTransfer as integer 0/1 flags, independent of historical read success. Non-applicable and malformed calls SHALL export nulls for these fields. Only transfer SHALL be enriched; allowance reads and other functions SHALL NOT be added.

#### Scenario: Historical read fails after valid decoding
- **WHEN** valid transfer calldata is decoded but its historical state cannot be obtained
- **THEN** amount and calldata flags remain available while balance-derived fields remain null and the state failure is explicit

#### Scenario: Zero and self transfer
- **WHEN** a valid transfer submits amount zero to its sender
- **THEN** tokenAmount is "0", isZeroAmount is 1 and isSelfTransfer is 1 regardless of its receipt outcome

### Requirement: Exact balance relationship candidates
Complete enrichment SHALL export senderHasEnoughBalance as integer 0/1 comparing reference sender balance to amount, and amountToSenderBalanceRatio as a reduced exact unsigned rational string. Zero sender balance SHALL yield a null ratio, including 0/0. Unavailable state SHALL yield nulls for both fields. Comparisons SHALL NOT promise execution outcomes.

#### Scenario: Exact ratio boundaries
- **WHEN** amount and positive balance are uint256 integers, including values above 2^53 or repeating decimal ratios
- **THEN** the ratio preserves their exact quotient as numerator/denominator without float conversion, clipping or rounding
- **WHEN** amount is zero and balance is positive
- **THEN** the ratio is "0/1" and senderHasEnoughBalance is 1

#### Scenario: Distinguish zero denominator from missing state
- **WHEN** both reference balances were obtained and sender balance is zero
- **THEN** status is complete, sender balance is "0", ratio is null and coverage is 1 only for amount zero
- **WHEN** historical state is unavailable
- **THEN** status is failed and sender balance, ratio and coverage are null
