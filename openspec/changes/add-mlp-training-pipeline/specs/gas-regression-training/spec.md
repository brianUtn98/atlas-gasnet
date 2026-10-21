# Spec Delta

## Purpose

Provide an offline, reproducible gasUsed regression experiment with auditable pre-execution inputs, chronological holdouts, and a training-only baseline comparison.

## ADDED Requirements

### Requirement: Verified Parquet sources
Preparation SHALL load only committed Parquet parts listed by complete schema-3 Ethereum Mainnet manifests. It SHALL verify part hashes, physical schema, row counts, selection ranges, and contiguous completed block coverage before fitting. JSON and PDF exports SHALL NOT contribute additional observations.

#### Scenario: Valid extraction
- **WHEN** a complete extraction with matching parts is supplied
- **THEN** decoded rows retain exact decimal and rational strings and provenance records the source fingerprints and hashes

#### Scenario: Invalid source
- **WHEN** a part is missing, corrupt, outside its range, incompatible in schema/network, or the extraction is incomplete
- **THEN** preparation fails before producing a trainable dataset

### Requirement: Unique and ordered transactions
Preparation SHALL identify rows by chainId and normalized transactionHash, collapse identical duplicates within an input split, and report removals. Conflicting duplicates and any identity shared between declared splits SHALL fail. Retained rows SHALL be sorted by numeric blockNumber, transactionIndex, and transactionHash.

#### Scenario: Repeated input
- **WHEN** repeated part references or identical rows occur inside one split
- **THEN** each transaction contributes one observation and the duplicate count is recorded

#### Scenario: Conflict or holdout overlap
- **WHEN** one identity has different field values or appears in both training and a holdout
- **THEN** preparation fails without silently choosing a version or moving the row

### Requirement: Chronological block allocation
Ordinary partitions SHALL use consecutive, nonoverlapping 60/15/25 percent portions of the configured inclusive block interval, including empty blocks. An entire block SHALL belong to one split. Existing poc-v3 boundaries SHALL be preserved. No random row split or row-count balancing SHALL be applied.

#### Scenario: Established collection
- **WHEN** poc-v3 is prepared
- **THEN** train uses 19000000–19001439, validation 19001440–19001799, and test 19001800–19002399 with actual row counts reported separately

#### Scenario: Short interval
- **WHEN** rounding a configured interval cannot allocate at least one block and one observed row to each ordinary split
- **THEN** the experiment fails with an insufficient-data explanation instead of borrowing rows

### Requirement: Separate unseen-contract evaluation
The USDT unseen-contract partition SHALL remain a separate final evaluation over the test window, with disjoint identities and contracts absent from training and validation. It SHALL NOT affect preprocessing, fitting, early stopping, feature selection, or tuning.

#### Scenario: Unknown contract
- **WHEN** the frozen pipeline evaluates the unseen-contract set
- **THEN** unknown contract categories use the training-defined unknown representation and results are labeled separately from temporal-test results

### Requirement: Explicit predictor eligibility
Default model inputs SHALL be limited to the seven initial predictors and nine enriched amount/state candidates. gasUsed SHALL be the uncorrected receipt target only. Audit fields, receipt outcomes, actual inclusion context, raw identities, and unselected transaction candidates SHALL NOT enter predictor vectors.

#### Scenario: Selected input contract
- **WHEN** the default predictor set is prepared
- **THEN** categories are chainName, to, and functionSelector; initial numeric fields are calldataBytes, calldataNonzeroBytes, value, and accessListStorageKeyCount
- **AND** enriched fields are tokenAmount, isZeroAmount, isSelfTransfer, senderHasEnoughBalance, amountToSenderBalanceRatio, senderTokenBalanceBeforeBlock, recipientTokenBalanceBeforeBlock, recipientBalanceWasZero, and senderBalanceEqualsAmount

#### Scenario: Leakage resistance
- **WHEN** labels, receipt status, timestamps, hashes, or enrichment audit reasons change while eligible inputs stay fixed
- **THEN** predictor vectors remain unchanged

#### Scenario: Reference-state eligibility
- **WHEN** historical balances are used
- **THEN** preparation checks their previous-block reference and documentation explains same-block uncertainty and the need for a known pre-execution reference at inference

### Requirement: Exact parsing and explicit missingness
Preparation SHALL validate unsigned quantities and exact rational ratios before floating conversion. Missing optional values SHALL retain per-field missing indicators and use transformed training medians; all-missing training fields SHALL use a recorded neutral fallback. Zero balances SHALL remain observed zeros. Malformed values SHALL fail rather than become missing.

#### Scenario: Zero denominator and unavailable history
- **WHEN** a complete row has zero sender balance and null ratio, or a failed row has null balances and ratio
- **THEN** zero balance and its missing indicator distinguish the first case from unavailable history without using audit status as an input

#### Scenario: No optional training coverage
- **WHEN** an optional field is entirely null in training
- **THEN** its recorded imputation fallback is transformed zero, its scale is one, and later observed values do not trigger refitting

#### Scenario: Numeric boundaries
- **WHEN** valid uint256 amounts, repeating rational ratios, true zero values, and binary indicators are prepared
- **THEN** finite model inputs are produced without interpreting missing values as factual zeros
- **WHEN** integers, indicators, ratios, or required targets are malformed or out of range
- **THEN** preparation fails with the offending field identified

### Requirement: Frozen training preprocessing
Transforms, imputation statistics, scaling, vocabulary, and feature order SHALL be fitted on training only, persisted, and reused unchanged for validation, tests, and inference. Unknown and null categories SHALL have explicit representations. Constant numeric columns SHALL use unit scale. The immutable data/poc/v1 snapshot SHALL NOT be overwritten.

#### Scenario: Held-out shift
- **WHEN** held-out values are extreme, missing, or contain unseen categories
- **THEN** preprocessing metadata remains unchanged and transformations remain finite or fail explicitly for invalid inputs

### Requirement: Reproducible regressor training
A run SHALL train the planned 64/32-hidden-unit, single-output MLP with Adam and validation early stopping. It SHALL record configuration, random seeds, dependency/device information, per-epoch sample-weighted training/validation losses, best epoch, and stop reason. Final predictions SHALL use the best validation checkpoint.

#### Scenario: Deterministic CPU repetition
- **WHEN** identical data and configuration run twice in the same supported CPU environment
- **THEN** split identities, preprocessing, loss history, selected epoch, and predictions agree within the documented deterministic tolerance

#### Scenario: Stopping and invalid training
- **WHEN** validation loss fails to improve for the configured patience
- **THEN** training stops and restores the best weights
- **WHEN** configuration is invalid, a required split is empty, or loss is nonfinite
- **THEN** the run fails without reporting a successful model

### Requirement: Median-by-function reference
The baseline SHALL predict training median gasUsed per functionSelector, with the global training median for unseen or missing selectors. It SHALL persist its medians and fallback policy. The reduced tensor feature set named X_baseline SHALL NOT be mistaken for this reference estimator.

#### Scenario: Known and unseen selectors
- **WHEN** a held-out row has a known selector
- **THEN** prediction uses that selector's training median regardless of contract
- **WHEN** the selector is unseen or missing
- **THEN** prediction uses the global training median without inspecting held-out labels

### Requirement: Final metrics and support
Evaluation SHALL report MAE and RMSE in gas units and dimensionless R² for the MLP and median reference on identical rows, with counts, per-contract/function summaries, and actual-versus-predicted data. Undefined R² SHALL be null with a reason. Final tests SHALL run only after model selection and SHALL NOT feed subsequent tuning within the experiment.

#### Scenario: Final comparison
- **WHEN** a selected model is evaluated
- **THEN** temporal-test and unseen-contract results are saved separately with frozen model, preprocessing, baseline, and data identities

#### Scenario: Undefined metric
- **WHEN** a group has fewer than two rows or a constant target
- **THEN** R² is null with the appropriate reason, while available MAE/RMSE and support are reported without a misleading perfect score

### Requirement: Portable experiment bundle
A saved run SHALL include model weights and architecture, frozen preprocessing with ordered input schema, baseline statistics, configuration, loss history, provenance, and artifact hashes. Reloaded inference SHALL require no fitting or RPC access and SHALL reject incompatible dimensions, versions, or artifact identities.

#### Scenario: Round trip
- **WHEN** a completed run is reloaded on CPU
- **THEN** the same raw eligible inputs yield the same features and predictions within the documented tolerance
- **WHEN** preprocessing is swapped, corrupted, or incompatible with model inputs
- **THEN** loading fails explicitly

### Requirement: Offline verification and English methodology
New behaviors SHALL have deterministic offline unit tests for success, boundary, and failure cases. English documentation SHALL describe commands, source selection, splits, feature units, missingness, baseline, reproducibility, and limitations. Eleven-row runs SHALL be labeled pipeline checks and SHALL NOT support model-performance claims.

#### Scenario: Small local smoke run
- **WHEN** the 11-row usdc-enriched-v3 example is used
- **THEN** it runs separately from poc-v3 with a documented short-interval split, never augments training, and any metrics are marked diagnostic only

#### Scenario: Clean offline tests
- **WHEN** tests run without extraction directories, RPC access, or private credentials
- **THEN** temporary deterministic Parquet fixtures exercise the pipeline independently of the local collection
