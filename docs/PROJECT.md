# Atlas GasNet — Project Plan

## Scope

Atlas GasNet will investigate whether transaction information available before EVM execution can predict transaction `gasUsed`. The project is a supervised regression proof of concept, not a gas-price estimator.

The first experiment will use Ethereum Mainnet and a small set of smart contracts and functions selected for meaningful variation in gas consumption. The exact contracts, function selectors, historical range, and initial sample size are project decisions tracked in the GitHub issues.

## Planned workflow

1. Define the proof-of-concept scope and eligible pre-execution features.
2. Collect transactions and receipts from validated Ethereum RPC endpoints using the historical extractor.
3. Store a documented, deduplicated dataset in Parquet format (CSV export is deferred).
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
- Optional state candidates: exact ERC-20 sender/recipient balances at the end of the
  previous block, recipient-balance-zero and sender-balance-equals-amount indicators.
  Transfer enrichment also exports the exact calldata token amount, zero-amount and
  self-transfer flags, a reference-balance sufficiency flag and an exact rational
  amount-to-sender-balance ratio. Zero denominator gives null and is distinguishable
  from missing history through reference balances/status. These fields require no
  additional RPC reads; valid calldata fields survive unavailable historical state.
  These approximate pre-transaction state; earlier same-block activity can change it.
  Balance equality is not evidence that a transfer emptied the sender. Missing state
  remains null with explicit audit status; no label correction or causal attribution
  of gas differences is applied. At prediction time, record a known reference block
  available before execution and evaluate the mismatch with historical inclusion-minus-one.
  Post-execution balances would be audit data, excluded from predictor inputs.
- Planned chronological split: 60% train, 15% validation, 25% test.
- Planned final metrics: MAE, RMSE, and R², with comparisons by contract and function selector where sample size permits.

The initial dataset target is 5,000–10,000 transactions, subject to availability and documented selection criteria. No synthetic data or private RPC credentials will be added to the repository.

## Reproducibility and privacy

Public Ethereum RPC access, configuration templates, checkpoints, and dataset provenance should be documented. Secrets, API keys, private RPC URLs, local extraction runs and model checkpoints remain outside version control. The explicitly approved, bounded PoC release under `data/poc/v1/` is versioned in JSON and PyTorch tensor format, with immutable source provenance, hashes and training-only preprocessing; see its [dataset card](../data/poc/v1/README.md).

## Current status

**Proof of Concept.** The TypeScript historical extractor and the reproducible JSON/PyTorch dataset snapshot are implemented. The snapshot contains 15,937 distinct Ethereum transactions, with preprocessing fitted only on training. Model training and evaluation remain planned. Extraction supports ETHEREUM, ETHEREUM_SEPOLIA, AVALANCHE (C-Chain), AVALANCHE_FUJI, POLYGON and POLYGON_AMOY. This operational support does not broaden the initial Ethereum Mainnet experiment or imply that testnet and mainnet observations should be pooled. See [extractor.md](extractor.md) for executable configuration, data dictionary, public endpoint limitations and resume instructions.
