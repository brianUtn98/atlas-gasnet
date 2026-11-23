# E3: actual Colab reproduction and report evidence

Executed on 2026-11-23 in [this saved Colab notebook](https://colab.research.google.com/drive/1KawDL44c8MWIt9HdeMObTE2OTJ_ZBaOR).
The [executed notebook with outputs](executed.ipynb), complete model archive and
genuine screenshots are retained here. The [source notebook](../../notebooks/atlas_gasnet_e3_evidence_colab.ipynb)
contains the same experiment with outputs cleared.

This repeats the fixed E3 protocol on previously evaluated data. It is a
reproduction, not an independent new confirmation. The [earlier local E3 run](../e3-2026-11-23/README.md)
is retained separately; neither run was chosen using final-test performance.
The academic Google Doc remains unchanged pending the professor's instructions.

## Data and selection

| Partition | Previous E2 rows | E3 rows | E3 block bounds, inclusive |
| --- | ---: | ---: | --- |
| Training | 7,195 | 155,435 | 19,010,000-19,039,999 |
| Validation | 1,373 | 39,111 | 19,040,000-19,047,499 |
| Temporal test | 2,466 | 59,504 | 19,047,500-19,059,999 |
| Unseen USDT | 4,903 | 145,124 | 19,047,500-19,059,999 |
| Total | 15,937 | 399,174 | |

Both E3 learned models use the same 36 ordered features. Preprocessing, target
transforms and selector medians fit training only. USDT is excluded from fitting.
Training code is pinned to `28daec0f22501d1bd4c0ed3f84c243fdb2dbc4d3`.
The input archive SHA-256 is
`51e64ad07fa7d77b0562de436d42eeaa559ab2e6dd20796c988a27cc8e007f32`.
Reproducing fitting requires the original four E3 manifests and listed Parquet
files; these inputs are not included in the model archive.

MLP uses 36-64-32-1, ReLU, Adam 0.001, batch 64, seed 42, CPU/one thread,
maximum 500 epochs, patience 25 and min_delta 0.000001. It ran 84 epochs and
restored epoch 59 by validation normalized MSE. GP uses the two previously fixed
500-population/20-generation candidates, seed 42 and one worker. Candidate 0
won by validation gas-unit MAE: 4,997.940235679417 versus 5,686.663027258715.
Its tree has seven nodes and depth three. Training-cell wall time for both
learned models and bundle creation was 666.37 seconds.

The reproduction freeze was recorded at `2026-11-23T06:31:33.601418+00:00`, before
this run's final evaluation. It explicitly records that prior local scores were
already public. No fitting or reselection followed inspection of final errors.

## Comparison on identical E3 observations

The E2 reference is the unchanged original retained MLP, evaluated on the new
E3 rows without fitting or reselection. Exact values are in
[supplementary-analysis.json](supplementary-analysis.json) and [metrics.json](metrics.json).

| Partition | Estimator | MAE (gas) | RMSE (gas) | R2 |
| --- | --- | ---: | ---: | ---: |
| Validation | Retained E2 MLP | 2,069.84 | 4,196.02 | 0.8441 |
| Validation | E3 MLP | 1,636.68 | 3,766.68 | 0.8744 |
| Validation | E3 symbolic | 4,997.94 | 6,799.26 | 0.5907 |
| Validation | E3 selector median | 7,583.94 | 10,077.96 | 0.1008 |
| Temporal | Retained E2 MLP | 2,449.92 | 4,672.85 | 0.8227 |
| Temporal | E3 MLP | 1,879.43 | 4,028.08 | 0.8683 |
| Temporal | E3 symbolic | 5,249.89 | 7,116.94 | 0.5887 |
| Temporal | E3 selector median | 7,555.65 | 10,215.44 | 0.1526 |
| USDT | Retained E2 MLP | 3,341.20 | 4,950.15 | 0.7626 |
| USDT | E3 MLP | 7,152.09 | 8,019.09 | 0.3769 |
| USDT | E3 symbolic | 3,360.01 | 5,560.77 | 0.7004 |
| USDT | E3 selector median | 8,997.55 | 11,997.47 | -0.3946 |

E3 MLP improved temporal MAE against the fixed E2 reference. The retained E2 MLP
had the lowest USDT errors across all four models. Symbolic led USDT within the
three E3 estimators. More data therefore did not improve every condition.
This fixed-reference comparison does not isolate data volume as the only cause.

Colab used Linux/Python 3.13.18; the local run used Windows/Python 3.12.14.
Both used the recorded pinned library versions, but MLP training did not
reproduce bit for bit: local MLP restored epoch 95 versus Colab epoch 59.
Do not mix the scores or present either environment as an independently
confirmed result. GP and baseline aggregate scores agreed across runs.

## Evidence index and suggested captions

| File | Suggested report caption |
| --- | --- |
| [01-data-and-final-metrics.jpg](screenshots/01-data-and-final-metrics.jpg) | Actual Colab execution: partition sizes, fixed configuration and separate final-test results. |
| [02-mlp-learning.jpg](screenshots/02-mlp-learning.jpg) | MLP training/validation normalized MSE; epoch 59 restored after early stopping at epoch 84. |
| [03-symbolic-learning.jpg](screenshots/03-symbolic-learning.jpg) | Two fixed GP candidates: generation training objective; final selection uses separate validation MAE. |
| [04-validation-selection.jpg](screenshots/04-validation-selection.jpg) | Common validation gas-unit metrics and validation-only MLP/GP selection decisions. |
| [05-e2-e3-same-rows.jpg](screenshots/05-e2-e3-same-rows.jpg) | Unchanged E2 MLP and all E3 estimators evaluated on the same validation, temporal and USDT rows. |
| [06-validation-by-function.jpg](screenshots/06-validation-by-function.jpg) | Validation error and sample support by function selector; aggregate accuracy hides weaker groups. |
| [07-cases-and-verification.jpg](screenshots/07-cases-and-verification.jpg) | Three largest MLP validation errors, identified by transaction, and persisted-bundle verification. These are diagnostic extremes, not representative samples. |

Original exportable figures: [MLP learning](mlp-learning.png),
[symbolic evolution](symbolic-learning.png), [validation predictions](validation.png),
[temporal predictions](test.png), [USDT predictions](unseen-contract.png).
Use these PNGs for readable report figures; screenshots document actual Colab UI.
MLP training MSE and GP training MAE are normalized and have different objectives;
their curve heights cannot directly rank the two model families.

## Model persistence and verification

[selected-run.zip](selected-run.zip) contains the `e3-colab-run/` folder with MLP
weights, preprocessing, baseline, exact symbolic tree, configuration, histories,
freeze, provenance, hash manifests, all validation/final predictions, figures,
and E2 reference predictions/metrics. Archive size: **29,543,440 bytes**.
SHA-256: `4d12cadde7b8d7c1564de305ea8ecae216a98b2b4b685be5fb6fa292cd61d6ac`.

The download was recovered from the Colab export link in bounded parts after
direct browser downloads failed. Its size and hash match the original cloud
archive exactly. ZIP CRC, safe extraction paths, model/evaluation manifests,
frozen hashes and all three model loaders passed locally. Original figure
bytes and full-precision JSON reports were copied directly from that archive.

Colab verified unchanged final evaluation and exact three-model predictions
after ZIP reload in its original environment. Local checks additionally matched
all 243,739 evaluation row IDs/labels and recomputed aggregate metrics against
the archived CSVs, including the E2 reference. On 512 evenly spaced rows per
partition, reloaded Windows inference differed from archived MLP predictions
by at most **0.0025929952 gas**; symbolic and baseline predictions matched
exactly. [summary.json](summary.json) records counts, differences and tolerances.
This cross-platform inference check does not claim identical training outcomes.

## Remaining broader work

The prospective report plan's GP-on-E2 condition, eight-configuration grid and
five-seed sensitivity study have not been completed. Current evidence covers
two fixed GP candidates and seed 42. Further development after consulting E3
final scores needs a new unconsulted holdout or explicit exploratory labelling.
Extend the academic report after receiving the professor's guidance. Commit
and push the retained evidence through the authorized normal CLI environment.
