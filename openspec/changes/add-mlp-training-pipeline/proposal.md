# Proposal

## Why

Atlas GasNet has schema-3 enriched extractions and a versioned tensor snapshot, but no reproducible training or evaluation workflow. A small offline pipeline will connect verified Parquet sources to the planned MLP and median-by-function comparison without temporal leakage.

## What Changes

- Load manifest-listed Parquet parts, verify provenance, and deduplicate transaction identities with conflicting duplicates rejected.
- Preserve chronological 60/15/25 block partitions and the additional unseen-contract holdout; use the overlapping 11-row USDC example only for pipeline verification.
- Prepare the seven initial predictors and nine enriched amount/state candidates with explicit missingness and training-only fitting.
- Train a PyTorch input→64→32→1 regressor with Adam, reproducible seeds, validation early stopping, saved loss history, and a portable model/preprocessing bundle.
- Fit the planned median-by-function baseline on training only; report MAE, RMSE, R², support, and limitations on identical held-out rows.
- Add deterministic offline tests and English usage/methodology documentation.

Scope covers one explainable experiment, not a hyperparameter search, new extraction, deployment, or a performance claim from 11 observations. Related issues: [preprocessing #3](https://github.com/brianUtn98/atlas-gasnet/issues/3), [MLP #4](https://github.com/brianUtn98/atlas-gasnet/issues/4), [evaluation #7](https://github.com/brianUtn98/atlas-gasnet/issues/7), [baseline #9](https://github.com/brianUtn98/atlas-gasnet/issues/9).

## Capabilities

### New Capabilities

- `gas-regression-training`: Offline preparation, reproducible training, persistence, and leakage-safe comparison of gas regressors.

### Modified Capabilities

None.

## Impact

Extend `training/` and its tests, add Pandas/PyArrow/scikit-learn dependencies and English training documentation with optional Colab usage. Preserve the immutable `data/poc/v1` release and extractor behavior. Generated models and reports remain local.
