# Design

## Context

See `proposal.md` for motivation. This design is warranted by new Parquet dependencies and changes spanning preparation, modeling, evaluation, and artifact loading.

Observed repository state:

- `openspec/config.yaml`, `README.md`, and `docs/PROJECT.md` establish PyTorch, a median-by-function baseline, chronological block splits, and pre-execution eligibility. No main specs exist yet; the completed extractor/enrichment changes remain unarchived and their delta specs were reviewed.
- `training/prepare_dataset.py` currently reads JSON exports, verifies Parquet hashes without decoding them, and creates the immutable `data/poc/v1` snapshot. Its `FeaturePreprocessor` already has a narrow feature allowlist, log transforms, median imputation, population standardization, unknown categories, and per-field missing indicators. It currently rejects an optional field with no observed training values.
- `training/dataset.py` loads frozen tensors and verifies artifact hashes. `X_baseline` means the initial feature subset, not the planned median estimator. There is no training loop, median estimator, or final evaluation workflow. Requirements currently contain Torch and NumPy only.
- `docs/poc-data.md` still says the full runs have not executed; local `poc-v3/collection-summary.md`, source manifests, and the versioned dataset card record completion. Implementation documentation must reconcile this stale sentence without changing collection facts.
- The supplied `E:/Users/Brian/Downloads/draft_tp_prediccion_gas_used.pdf` was read in full. It motivates supervised gasUsed regression and suggests several alternative stacks and candidate inputs. These are background proposals, not instructions overriding the current request: use the repository's confirmed stack and selected feature allowlist; actual inclusion-block context remains excluded. Traditional gas-estimator comparisons and architecture searches remain future work.
- The supplied GitHub Projects view could not be fetched. Repository issues [#3](https://github.com/brianUtn98/atlas-gasnet/issues/3), [#4](https://github.com/brianUtn98/atlas-gasnet/issues/4), [#7](https://github.com/brianUtn98/atlas-gasnet/issues/7), and [#9](https://github.com/brianUtn98/atlas-gasnet/issues/9) were read directly. No board state is assumed.

Actual source inspection decoded `usdc-enriched-v3/part-19000000-19000002.parquet` with the installed Hyparquet reader and checked every field against JSON: 39 columns, 11 matching rows, block counts 1/5/5, one USDC transfer selector, all 11 enrichments complete. Quantities including gasUsed are UTF-8 decimal strings; the ratio is a UTF-8 rational string; counts/flags are INT32. Optional fields include all nine enriched candidates, fee fields, selector, state reference, and failure reason. Access lists are JSON strings. Nullable physical fields are not necessarily null in this sample: all nine enriched candidates are present. Fee nulls reflect transaction type and do not enter this experiment.

The actual `poc-v3` manifests and collection summary provide the primary experiment:

| Partition | Rows | Inclusive blocks | Complete / not applicable / failed enrichment |
| --- | ---: | --- | --- |
| train | 7,195 | 19000000–19001439 | 3969 / 3218 / 8 |
| validation | 1,373 | 19001440–19001799 | 803 / 569 / 1 |
| test | 2,466 | 19001800–19002399 | 1557 / 909 / 0 |
| unseen-contract | 4,903 | 19001800–19002399 | 4280 / 616 / 7 |

The ordinary set has 11,034 transactions; 15,937 includes the separate unseen-contract evaluation. The 11-row example overlaps training. The recorded enrichment failures are `invalid_calldata`; unavailable-history behavior requires deterministic fixtures, not an assumption that it was observed here.

## Goals / Non-Goals

**Goals:** One offline command path from verified Parquet to a reloadable regressor and reference comparison; small reusable Python modules; deterministic CPU verification; explicit data and evaluation provenance.

**Non-Goals:** New extraction, automatic training during extraction, mutation of `data/poc/v1`, baseline replacement, GPU reproducibility across platforms, automated hyperparameter search, serving infrastructure, or evidence of accuracy from the tiny example. Colab is a thin caller of the same modules, not a second implementation.

## Decisions

### 1. Manifest-driven Parquet preparation

Add a dedicated training preparation path using Pandas and PyArrow, sharing the existing predictor logic where compatible. Add scikit-learn for metrics; pin and verify compatible dependency versions during apply. Arbitrary recursive directory globs risk combining the sample, release copies, and held-out contracts, so accept an explicit source mode: `poc` defaults to `data/extractions/poc-v3`; `smoke` explicitly targets `data/extractions/usdc-enriched-v3`.

Read only manifest-listed committed parts, resolve paths inside the selected extraction directory, verify SHA-256, schema/version, row counts per part and manifest, complete contiguous block coverage, nextBlock, range membership, chain ID 1, and expected contracts/functions. Reject incomplete or incompatible data. Ignore unlisted files. Never read JSON/PDF as extra model observations. Validate before float conversion; preserve raw rows and row IDs for audit.

Read each listed path once. Normalize identity casing and numeric identity components. Inside a split, compare all normalized schema fields for duplicate identities: identical rows collapse with an audit count; differing values fail. Count source rows before deduplication and retained rows after it. Any identity crossing declared partitions fails even if identical. Sort by numeric block height and transaction index with hash as tie-breaker. This is deterministic across input file order. The source integrity checks do not excuse conflicting duplicates.

### 2. Preserve block partitions and handle tiny ranges explicitly

For `poc`, validate and preserve the existing 1440/360/600 consecutive block windows and identical ordinary contract/function filters. USDT remains separate over the final 600 blocks and must be contract-disjoint from train/validation. Do not recompute splits from populated blocks or transaction counts.

For a single configured interval, let N = end - start + 1. Require N >= 3. Use integer cut offsets `a = min(max(floor(0.60*N), 1), N-2)` and `b = min(max(floor(0.75*N), a+1), N-1)`. Allocate offsets `[0,a)`, `[a,b)`, `[b,N)`, counting empty blocks. Record nominal fractions, achieved block fractions, and bounds; reject any empty observed split. For N=2400 this reproduces 1440/360/600. The three-block smoke source yields one block per partition (1/5/5 rows), explicitly an unavoidable rounding exception, not an exact 60/15/25 result. Never split a block to improve proportions or support. Fixtures with more blocks verify ordinary rounding and empty-block handling.

### 3. Fixed feature contract and explicit null handling

Use these selected inputs rather than every field the manifest labels as a candidate:

| Group | Fields | Preparation |
| --- | --- | --- |
| Categories | chainName, to, functionSelector | Sorted training vocabulary; dedicated unknown and null buckets |
| Calldata counts | calldataBytes, calldataNonzeroBytes | Numeric identity |
| Native/access-list quantities | value, accessListStorageKeyCount | log1p |
| Enriched quantities | tokenAmount, senderTokenBalanceBeforeBlock, recipientTokenBalanceBeforeBlock | log1p |
| Enriched ratio | amountToSenderBalanceRatio | Parse exact unsigned numerator/positive denominator, then log1p |
| Enriched indicators | isZeroAmount, isSelfTransfer, senderHasEnoughBalance, recipientBalanceWasZero, senderBalanceEqualsAmount | Validate integer 0/1, numeric identity |

Parse exact unsigned decimal strings using Python integers, bounded to uint256 for EVM quantities; validate target fits positive int64 and retains its exact value. Parse rational components before float conversion, bound them to uint256, require reduced encoding and a nonzero denominator. Reject invalid or nonfinite inputs; never silently coerce them to null. Keep native value in wei and amounts in token base units. The ratio is dimensionless. Do not interpret different token units as a common economic value.

Fit imputation after each numeric transform using only training: median of observed values, then mean and population standard deviation of imputed training values. Use scale 1 for constants. Nine enriched fields each get a missing indicator; never add a generic missingness flag in place of these. If an optional field is all missing in training, use transformed imputation 0, mean 0, scale 1, and record `all_missing_training=true`; later observations still transform through the frozen rule. Missing required numeric fields fail. Null selectors map to a stable null bucket rather than a fabricated function. Preserve all allowlisted columns, even constants, to keep feature order stable.

Keep valid calldata-derived amount/flags when history is unavailable. Null ratios from complete zero-balance rows are distinguishable from missing history by observed balance plus its missing indicator. Status/reason/reference height remain audit only. Validate complete-state references at inclusion-minus-one and reject contradictory state/null combinations according to schema-3 semantics. No post-execution balances, receipt status, gasUsed, IDs, raw sender/input/access list, fees, gasLimit, nonce/type, inclusion timestamp/height/index/hash, or enrichment audit fields enter X. The latter transaction candidates are deliberately unselected for this bounded first experiment.

Reuse/refactor `FeaturePreprocessor` without changing the immutable release contract: keep legacy version-1 metadata/default behavior and its reconstruction tests; put new null-category/all-missing policy in a versioned training preprocessor. New output never overwrites v1. Persist explicit ordered feature names, units/transforms, vocabulary, imputation and scaling statistics, policy version, and training row identity hash. Training-only metadata cannot change during transform.

### 4. Small deterministic PyTorch trainer

Separate preparation, model/trainer, baseline, evaluation, and CLI responsibilities under `training/`. The model is `Linear(d,64) → ReLU → Linear(64,32) → ReLU → Linear(32,1)`, where d comes from frozen feature order. The output is linear with no rounding/clipping of predictions. Proposed initial defaults: CPU, seed 42, Adam learning rate 0.001, batch size 64, maximum 500 epochs, patience 25, absolute min_delta 0.000001, no dropout or weight decay. These are recorded starting values, not tuned findings; validate all configuration values.

Internally standardize targets with training mean/population scale (unit scale for constants) to make MSE and Adam practical across gas magnitudes; persist this separate model target transform without changing raw labels or legacy tensors. Invert before all gas-unit predictions and metrics. Save loss histories as normalized MSE with units identified. Compute training/validation epoch loss weighted by sample count, including final partial batches. Evaluate validation with eval/no_grad; shuffled mini-batches apply only to training.

Seed Python, NumPy, Torch, and the DataLoader generator before initialization; use num_workers=0, a fixed CPU thread count, and deterministic Torch algorithms. Record Python/library versions, platform/device, thread settings, seed, configuration and code revision. Optional CUDA requires its seed/settings and a documented lack of cross-device bitwise guarantees. Unit tests repeat short CPU runs in the same environment and compare numerical outputs with rtol=0, atol=1e-6; do not compare timestamped artifact bytes.

An improvement requires `validation_loss < best_loss - min_delta`. Save detached cloned best weights, reset patience only on improvement, stop after patience consecutive nonimprovements, and restore best weights on either early stop or epoch limit. Fail on nonfinite losses/gradients or invalid configuration; record best epoch and stop reason. Test the stopping rule with scripted loss sequences, not a brittle assertion that a tiny dataset learns a particular score.

### 5. Keep the planned median reference and final-test discipline

Fit one median per functionSelector from training labels alone. This follows issue #9 literally; do not silently change it to contract/function medians or a second neural model. Missing and unseen selectors use the global training median, a declared extension needed for total prediction coverage. Store exact selector/global medians and fallback counts. `X_baseline` remains a feature-ablation option in the existing snapshot and is not required to fit this reference.

The training command reads train/validation rows only after source validation; a separate explicit evaluation command loads a completed selected bundle and the holdouts. It verifies data/split fingerprints before reading final labels for metrics. Report validation diagnostics and final metrics separately. Record final evaluation in the run; reject accidental overwrite/re-evaluation for the same run unless an explicit verification mode repeats the unchanged bundle and labels it as such. Do not use final results to tune the current experiment; a new experiment needs a newly reserved future test window under project policy.

Use scikit-learn MAE/RMSE/R² on original gas units. Guard R² for N<2 and constant targets, returning JSON null plus reason instead of library finite-score substitution. Reject empty evaluation inputs or nonfinite predictions. Save aggregate and per-contract/function support and errors for both estimators on identical rows; label rare-group limitations. Persist aligned actual/predicted/residual tables and reproducible actual-versus-predicted plots. Smoke metrics always carry `pipeline_check_only=true`; no minimum improvement or R² threshold is an acceptance criterion.

### 6. Self-contained local run artifacts

Create a new non-overwriting directory under ignored `models/<run-id>/`. Persist `model.pt` as state_dict plus versioned architecture/target-transform metadata, `preprocessing.json`, `baseline.json`, `config.json`, `history.json`, and a run manifest containing source hashes/fingerprints, split bounds/row IDs or their hashes, feature order/dimension, seed/runtime, selected epoch, stop reason, and per-artifact hashes. Evaluation adds separately identified metrics, predictions, and plots. Write a completion marker/manifest only after successful validation; incomplete runs cannot be loaded as completed models.

Reload with CPU map_location and weights_only loading, reconstruct the architecture, validate hashes/versions/dimensions and exact preprocessing identity, and transform raw eligible inputs without refitting or RPC access. Verify prediction parity before declaring completion. Hash association prevents accidentally pairing weights with another valid preprocessor. Keep generated data, weights, histories and reports outside Git; version only small deterministic fixtures or generate them in temporary test directories.

## Risks / Trade-offs

- Prior-block balances approximate pre-state and equality does not prove depletion → document same-block effects, preserve original gasUsed, and require a known reference block at prediction time.
- The 11-row sample has no enriched missing values and just three blocks → use it only for smoke verification; generated fixtures cover unavailable history, not-applicable calls, zero denominators, all-missing columns, and malformed data.
- Short time coverage and rare functions limit conclusions even with 15,937 rows → report support, keep temporal and unseen-contract evaluations distinct, and document scope.
- Floating tensors approximate exact EVM values → preserve exact raw strings/provenance, transform only after validation, check finiteness, and test values above 2^53 and uint256 boundaries.
- Refactoring preparation could invalidate released data → retain version-1 reconstruction tests and publish new preprocessing versions separately.
- Cross-platform numerical changes can defeat strict repetition → constrain deterministic tests to the same CPU environment and save runtime metadata; no promise of identical results across Torch/device versions.

## Migration Plan

Add modules and pinned dependencies without modifying extraction or released dataset bytes. Document prepare/train/evaluate/predict commands in `docs/training.md`, link from README, reconcile the stale collection-status statement, and provide equivalent Colab steps calling those commands. Keep existing snapshot tests passing. Rollback is removal of the new modules/entry points and their unused local run directories; no data migration or remote write is required.
