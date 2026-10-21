# Selected Colab experiment — 2026-10-21

The original temporary Colab runtime had expired. Repeating the fixed CPU
configuration (seed 42, one thread) reproduced the saved train/validation results:
61 epochs, selected epoch 36, validation MAE 2006.2321128258902 gas.
Only after selecting this run were the temporal and USDT tests evaluated.
No parameters or features were changed using final-test results.

| Set | Estimator | Rows | MAE (gas) | RMSE (gas) | R² |
| --- | --- | ---: | ---: | ---: | ---: |
| Temporal test | MLP | 2466 | 1740.20 | 3811.34 | 0.8629 |
| Temporal test | Function median | 2466 | 6821.99 | 9908.33 | 0.0732 |
| USDT | MLP | 4903 | 3395.39 | 4405.60 | 0.7906 |
| USDT | Function median | 4903 | 8604.64 | 11554.49 | -0.4401 |

`summary.json` contains unrounded train/validation diagnostics, final-test scores
and three identified validation examples. `evaluation/` retains the original
Colab output, including aligned predictions for both estimators and plots.
`selected-run.zip` retains the selected model weights, frozen transformations,
median baseline, history, runtime configuration, provenance and hash manifests.
Its contents were downloaded from the actual Colab execution and hash-verified.
The extra top-level `delivery-summary.json` is a readable report extract.

The training code is commit `7bb86975198e448322453c932867593ffe7f4561`.
The CPU hardware/library environment can affect repeated numerical results;
the retained weights and CSV files are the evidence for this reported run.
