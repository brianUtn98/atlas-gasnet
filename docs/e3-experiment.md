# E3: MLP and Genetic Programming comparison

Genetic Programming is the accepted second technique, confirmed 2026-11-22.
It evolves a gasUsed expression directly. The experiment compares that regressor,
the PyTorch MLP and a selector-median baseline. This integration is executable;
the full fixed-candidate E3 run and final evaluation completed locally on
2026-11-23. [Retained results](../results/e3-2026-11-23/README.md) include the
frozen models, candidate history, metrics, predictions and hash manifests.

## Data preparation

The campaign contains 399,174 transactions: 155,435 train, 39,111 validation,
59,504 temporal-test and 145,124 USDT observations. Full preparation and bundle
integrity were verified locally on 2026-11-22 at `models/e3-prepared`, with 36
ordered features and preprocessing fitted only on the 155,435 training rows.
Preparation preceded the completed 2026-11-23 fitting and final evaluation.
Collection manifests are local;
the existing published E2 archive does not contain E3. Preparation uses only
hash-verified, manifest-listed Parquet parts, never the duplicate JSON exports or
the operational pilot. It rejects incomplete collections and overlapping identities.

E3 reads inclusive bounds from four extraction manifests. Ordinary splits must
match the existing 60/15/25 inclusive-block allocation, use identical contract /
function and enrichment filters, and start after the E2 final-test window.
The USDT-only contract holdout must use the temporal-test window and remain
contract-disjoint. The current bounds are 19010000-19039999 / 19040000-19047499 /
19047500-19059999; a later campaign can supply different valid bounds through
`--source`. Mode `poc` retains its fixed E2 checks.

Both learned estimators use the same frozen v2 feature order and row identities.
Only train fits imputations, normalization, categories, target scaling and baseline
medians. Receipts provide gasUsed labels only; receipt outcomes, actual inclusion
context and other post-execution fields stay excluded from predictors. Test data
can be prepared and integrity-checked without using prediction errors for selection.

From the repository root, with Python 3.12+ and a fresh output directory:

```sh
python -m pip install -r training/requirements-symbolic.txt
python -m training.pipeline prepare --mode e3 --output models/e3-prepared
```

## Train and select on validation

```sh
python -m training.pipeline train --prepared models/e3-prepared --output models/e3-run --with-symbolic --symbolic-config config/training.e3.symbolic.json
python -m training.pipeline evaluate --run models/e3-run --prepared models/e3-prepared --validation-only
```

The checked-in candidate list fixes two starting configurations (500 individuals,
20 generations, seed 42) differing only in parsimony coefficient: .001 and .01.
These are predefined experimental choices, not tuned findings or guarantees.
Omitting `--symbolic-config` uses one default `SymbolicConfig`; omitting
`--with-symbolic` preserves MLP/baseline-only behavior. Candidate JSON must be a
nonempty list of valid configuration objects. Every candidate uses full train,
CPU and one worker; this can be slow on E3. No full symbolic fitting is triggered
by preparation or by opening the notebook.

Evolution minimizes normalized training MAE. Candidate selection minimizes gas-unit
validation MAE, with first-candidate tie breaking. Validation never fits a formula
or its target scaling. The MLP retains best-validation normalized-MSE early
stopping. The two algorithms have different training objectives and compute costs;
their common comparison uses gas-unit validation and final-test metrics. Baseline
medians fit train only. Training deserializes no final-test rows.

Review `validation/metrics.json`, `history.json` (MLP) and
`symbolic-history.json` (candidate configurations, validation MAE, selected index,
tree size/depth, generation fitness and engine version). A new candidate list
requires a fresh run directory. Freeze feature choices and both selected models
before final evaluation. The separate
[E3 notebook](../notebooks/atlas_gasnet_e3_colab.ipynb) follows these steps and
requires `MODELS_FROZEN = True` before it can open final tests. In Colab, supply
the four E3 extraction directories at `data/extractions/e3-v1` first; the notebook
does not substitute the published E2 data.

## Completed fixed-candidate run

Training code was `28daec0f22501d1bd4c0ed3f84c243fdb2dbc4d3`, on local CPU
with the pinned dependencies, seed 42 and one worker/thread. MLP restored epoch
95 after 120 epochs. Symbolic candidate 0 (parsimony .001; seven nodes, depth
three) beat candidate 1 by validation MAE: 4,997.94 versus 5,686.66 gas.
Validation MAE was 1,706.96 for MLP and 7,583.94 for the selector-median baseline.
The validation-only selection and model hashes were recorded in
`model-freeze.json` before either final score was computed.

| Final partition | Estimator | MAE (gas) | RMSE (gas) | R² |
| --- | --- | ---: | ---: | ---: |
| Temporal, 59,504 rows | MLP | 1,958.20 | 4,048.40 | 0.8669 |
| Temporal, 59,504 rows | Symbolic | 5,249.89 | 7,116.94 | 0.5887 |
| Temporal, 59,504 rows | Selector median | 7,555.65 | 10,215.44 | 0.1526 |
| USDT, 145,124 rows | MLP | 9,019.59 | 10,099.42 | 0.0118 |
| USDT, 145,124 rows | Symbolic | 3,360.01 | 5,560.77 | 0.7004 |
| USDT, 145,124 rows | Selector median | 8,997.55 | 11,997.47 | -0.3946 |

MLP led validation and temporal MAE, but its USDT MAE was slightly above the
baseline. The selected symbolic formula had the lowest USDT errors in this
run. This contract-shift result is descriptive, not permission to reselect or
tune using USDT. No post-test adjustment was made. E2 and E3 use different
observations, so their scores are not a controlled data-volume comparison.

Final evaluation was repeated with `--verify` and matched exactly. After
verification, export the frozen run without fitting or refitting:

```sh
python scripts/publish-e3-results.py --run models/e3-run --prepared models/e3-prepared --output results/e3-2026-11-23
```

The export refuses an existing output directory. Its ZIP is sufficient for
portable inference; reproducing training still requires the original E3
manifests and listed Parquet parts. The notebook also offers a retained-result
inspection path that needs neither RPC access nor the original extractions.

## Persistence and final comparison

The separate [actual Colab reproduction](e3-colab-evidence.md) repeats this
fixed protocol and retains an executed notebook, a complete run archive,
original plots and screenshots. It additionally evaluates the unchanged E2
MLP on the same E3 observations. E3 MLP improves temporal MAE against that
reference, while the E2 model retains lower USDT errors than all E3 estimators.
Colab/local MLP training results differ by environment and remain separately
identified. This is reproduction on already consulted data, with no new tuning;
it does not complete the prospective E2 GP or five-seed sensitivity study.

The run remains self-contained with MLP weights, preprocessing, baseline,
configuration and provenance. It additionally hashes `symbolic.json` and
`symbolic-history.json`. The symbolic artifact stores a validated prefix tree,
full-precision constants, target transform and feature/preprocessor binding.
Portable prediction needs no gplearn import; no pickle or `eval` is used.
Protected division returns 1 at |denominator| <= .001, matching gplearn.
The readable formula is display-only and refers to the ordered transformed inputs.
Predictions are in gas units without clipping or rounding; negative predictions
and nonfinite failures remain visible. Existing E2 run bundles remain loadable.

After selection is frozen, run separately once:

```sh
python -m training.pipeline evaluate --run models/e3-run --prepared models/e3-prepared
python -m training.pipeline evaluate --run models/e3-run --prepared models/e3-prepared --verify
```

Reports compare all three estimators on identical rows, separately for validation,
temporal test and USDT: MAE, RMSE, R², contract/function groups, aligned CSV
predictions/residuals and actual-versus-predicted plots. Validation diagnostics
have their own directory and do not consume final labels. Final evaluation does
not refit, select or overwrite a run. Its scores cannot guide further E3 tuning;
another experiment needs a new unconsulted test window. More observations across
one week and a single unseen contract still limit generalization claims.

Offline verification:

```sh
python -m unittest discover -s training -t . -v
ruff check training
ruff format --check training
```

Temporary Parquet fixtures verify E3 preparation, real small-population evolution,
validation selection, exact formula reload, final-label isolation and aligned
three-estimator evaluation. Fixture scores are not experimental findings.
