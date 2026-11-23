# E3: retained MLP, Genetic Programming and baseline experiment

Executed on local CPU. Training code revision: `28daec0f22501d1bd4c0ed3f84c243fdb2dbc4d3`.
This run uses all 155,435 training rows and the same 36 frozen features for both learned models.
Preprocessing, target transforms and baseline medians fit training only.

MLP ran 120 epochs, restored epoch 95, and stopped by `patience`.
Symbolic candidate 0 won by validation gas-unit MAE.
MLP epoch selection uses validation normalized MSE; the common comparison below uses gas-unit metrics.
All estimators were frozen before either final-test score was consulted; see `model-freeze.json`.

| Partition | Estimator | Rows | MAE (gas) | RMSE (gas) | R² |
| --- | --- | ---: | ---: | ---: | ---: |
| validation | mlp | 39,111 | 1,706.96 | 3,760.69 | 0.8748 |
| validation | selector_median | 39,111 | 7,583.94 | 10,077.96 | 0.1008 |
| validation | symbolic | 39,111 | 4,997.94 | 6,799.26 | 0.5907 |
| test | mlp | 59,504 | 1,958.20 | 4,048.40 | 0.8669 |
| test | selector_median | 59,504 | 7,555.65 | 10,215.44 | 0.1526 |
| test | symbolic | 59,504 | 5,249.89 | 7,116.94 | 0.5887 |
| unseen-contract | mlp | 145,124 | 9,019.59 | 10,099.42 | 0.0118 |
| unseen-contract | selector_median | 145,124 | 8,997.55 | 11,997.47 | -0.3946 |
| unseen-contract | symbolic | 145,124 | 3,360.01 | 5,560.77 | 0.7004 |

## Observed comparison

- Lowest validation MAE: `mlp` (1,706.96 gas).
- Lowest test MAE: `mlp` (1,958.20 gas).
- Lowest unseen-contract MAE: `symbolic` (3,360.01 gas).

MLP led validation and temporal MAE, while symbolic led USDT MAE and RMSE in this frozen run.
MLP USDT MAE was slightly above the selector baseline despite lower RMSE.
This is evidence of a contract-shift limitation in the selected MLP, not a general ranking of model families.
No model was changed or selected using final-test scores.

Selected symbolic expression (display only; exact constants are stored in the JSON tree):

```text
47331.938874770807 + 10875.809792596918 * (add(standardized:recipientBalanceWasZero, add(functionSelector=0x095ea7b3, mul(missing:senderTokenBalanceBeforeBlock, standardized:recipientBalanceWasZero))))
```

## Evidence and reproduction

`metrics.json` retains aggregate and contract/function metrics with row-identity bindings.
`summary.json` retains candidate choices, error quantiles, negative-prediction counts and artifact hashes.
`selected-run.zip` contains portable weights/formula, preprocessing, baseline, full history, provenance,
hash manifests, validation/final predictions and plots. It contains no original extraction data or credentials.
Archive SHA-256: `53d37279537cf90af8695ece9834dd43c143643d2a98769a7f54ade242504e8b`.

Extract the archive and use `training.bundles.load_run` or `predict_rows` on its `run/` directory.
Verification against the original prepared inputs uses:

```sh
python -m training.pipeline evaluate --run run --prepared models/e3-prepared --verify
```

The original E3 manifests and listed Parquet parts are still required to reproduce fitting;
the published E2 archive does not contain E3. See [the E3 guide](../../docs/e3-experiment.md).

## Limits

This is one fixed-seed experiment over a short Ethereum period, USDC/WETH9 training contracts
and one unseen USDT contract. The limited symbolic search is not evidence that every GP model
would perform similarly. Token base units differ across contracts; prior-block balances approximate
pre-transaction state, and enrichment is supported only for canonical transfers.
Predictions were neither clipped nor rounded. Final-test errors describe frozen models and cannot
guide further E3 tuning. E2 used different observations, so E2/E3 scores are not a controlled ablation.

The separate [Colab reproduction](../e3-colab-2026-11-23/README.md) subsequently
evaluated the unchanged original E2 MLP on the same E3 rows. That broader
comparison found lower USDT errors for the retained E2 model than for all E3
estimators. Keep the local/Colab MLP outcomes and their environments separate.
