# Atlas GasNet — Project Plan

## Scope

Atlas GasNet will investigate whether transaction information available before EVM execution can predict transaction `gasUsed`. The project is a supervised regression proof of concept, not a gas-price estimator.

The first experiment will use Ethereum Mainnet and a small set of smart contracts and functions selected for meaningful variation in gas consumption. The exact contracts, function selectors, historical range, and initial sample size are project decisions tracked in the GitHub issues.

## Planned workflow

1. Define the proof-of-concept scope and eligible pre-execution features.
2. Collect transactions and receipts from an Ethereum RPC endpoint.
3. Store a documented, deduplicated dataset in CSV or Parquet format.
4. Explore and preprocess the data without introducing temporal or execution-result leakage.
5. Establish a median-by-function baseline.
6. Train an MLP regressor in PyTorch.
7. Tune hyperparameters on the validation split.
8. Evaluate once on a chronological test split and analyze errors.
9. Document findings, limitations, and possible improvements.

## Initial model plan

The first neural model will use two hidden layers with 64 and 32 neurons, ReLU activations, and a numeric output for `gasUsed`. Adam, early stopping, and recorded training/validation loss are planned. The baseline will report MAE and RMSE so that the MLP can be compared against a simple reference.

## Data and evaluation policy

- Target: transaction `gasUsed`.
- Candidate inputs: information known before execution, such as transaction metadata, calldata-derived fields, sender/recipient context, and block context available at submission time.
- Exclusions: receipt fields, execution outcomes, or any feature only known after execution.
- Planned chronological split: 60% train, 15% validation, 25% test.
- Planned final metrics: MAE, RMSE, and R², with comparisons by contract and function selector where sample size permits.

The initial dataset target is 5,000–10,000 transactions, subject to availability and documented selection criteria. No synthetic data or private RPC credentials will be added to the repository.

## Reproducibility and privacy

Public Ethereum RPC access, configuration templates, checkpoints, and dataset provenance should be documented. Secrets, API keys, private RPC URLs, and large generated datasets must remain outside version control.

## Current status

**Planning / Proof of Concept.** This repository intentionally contains no implementation yet.
