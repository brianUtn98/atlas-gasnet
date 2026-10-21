# Offline training

Use Python 3.12+ and install `python -m pip install -r training/requirements-dev.txt`.
The dedicated training pipeline reads only schema-3 manifest-listed Parquet parts.
It validates physical schema, hashes, exact strings, counts, selection membership,
complete contiguous block coverage, and transaction identities before fitting.
Repeated references are read once; identical rows collapse with audit counts;
conflicting duplicates fail. Rows sort by numeric block/index then hash.
JSON, PDF, sample copies and unlisted Parquet files never add observations.

Source mode `poc` defaults to `data/extractions/poc-v3`, the primary experiment.
Mode `smoke` explicitly uses `data/extractions/usdc-enriched-v3` separately; its
11 rows overlap the primary training source and must never augment it.
All smoke results carry `pipeline_check_only=true` and make no accuracy claim.
The immutable JSON/tensor release under `data/poc/v1` uses its existing v1 loader;
this pipeline writes separate outputs and never regenerates that release.

Splits count inclusive configured blocks, including empty ones, not rows or
populated blocks. For N blocks require N>=3, set a=clamp(floor(.60N),1,N-2),
b=clamp(floor(.75N),a+1,N-1). Allocate offsets [0,a), [a,b), [b,N).
For 2400 blocks this is 1440/360/600; for three it is 1/1/1 (rounding exception).
Every observed partition must be nonempty; no block is shared or borrowed.
Provenance records bounds, achieved block fractions, row counts and identity hashes.
The primary source preserves 19000000–19001439 / 19001440–19001799 /
19001800–19002399 and identical ordinary contract/function filters. USDT stays
contract-disjoint in a separate unseen-contract partition over the test window.

Preprocessing v2 fits only train: categories `chainName`, `to`, `functionSelector`
use sorted vocabularies and dedicated unknown/null buckets. Numeric allowlist:
`calldataBytes`, `calldataNonzeroBytes` (counts, identity); `value` (wei, log1p);
`accessListStorageKeyCount` (count, log1p); `tokenAmount`,
`senderTokenBalanceBeforeBlock`, `recipientTokenBalanceBeforeBlock` (token base
units, log1p); `amountToSenderBalanceRatio` (dimensionless reduced rational,
log1p); `isZeroAmount`, `isSelfTransfer`, `senderHasEnoughBalance`,
`recipientBalanceWasZero`, `senderBalanceEqualsAmount` (0/1, identity).
Unsigned quantities and ratio components are validated as uint256 before floating
conversion. Targets retain positive int64 values. Token units have no shared
economic meaning. Numeric transforms use training median imputation followed by
training mean/population standard deviation; constants use scale 1. All-missing
optional training columns record a neutral median/mean 0 and scale 1. Each of the
nine enriched fields has its own missing indicator. Observed zero stays observed;
a null ratio from zero balance differs from unavailable history. Valid calldata
fields survive historical failures. No column is dropped for being constant.
Frozen metadata includes ordered features, units, statistics and training identity
hash; held-out inputs never refit it. Audit, labels, raw identities/calldata, fees,
gasLimit, nonce/type, receipt outcomes and actual inclusion context are excluded.
State consistency is checked during preparation, including inclusion-minus-one
reference, status/null combinations and balance/ratio indicators. Prior-block
state approximates pre-transaction state: earlier same-block calls can change it;
balance equality does not establish depletion. Inference needs a documented known
pre-execution reference block and must account for this historical mismatch.

The reference estimator fits one gasUsed median per functionSelector on training
alone, across contracts. Missing/unseen selectors use the global training median;
prediction reports fallback counts. Persisted medians never inspect held-out
labels. Rational strings also preserve exact fitted medians above floating-point
integer precision; model predictions/metrics use floating approximations.
`X_baseline` in the legacy snapshot is a reduced feature matrix, not this
median estimator.

The MLP is Linear(d,64) → ReLU → Linear(64,32) → ReLU → Linear(32,1).
The linear output is inverted to gas units without clipping or rounding. Defaults
are CPU, seed 42, one CPU thread, Adam lr=.001, batch size 64, max epochs 500,
patience 25 and absolute min_delta=1e-6; no dropout or weight decay. These are
starting values, not tuned findings. Target mean/population scale fit train only
(constant target scale 1). Loss history is sample-weighted **normalized MSE**,
including partial batches, not gas-unit MSE. Validation uses eval/no_grad.
Improvement means loss < best_loss - min_delta; ties consume patience. Best
detached weights restore on stopping or epoch limit. Invalid configuration,
empty splits and nonfinite loss/gradients fail the run. Python/NumPy/Torch and
the shuffled train DataLoader generator are seeded; workers=0 and deterministic
algorithms are enabled. Same-environment CPU repetition tolerance is rtol=0,
atol=1e-6. CUDA is optional and has no cross-device/platform bitwise guarantee;
set CUBLAS_WORKSPACE_CONFIG=:4096:8 before starting CUDA where Torch requires it.
Runtime/library/device/thread settings and code revision are recorded.

Run from the repository root (activate the environment first). Use fresh output
directories on every run; existing outputs are refused, including partial runs.

```sh
python -m training.pipeline prepare --mode poc --output models/poc-prepared
python -m training.pipeline train --prepared models/poc-prepared --output models/poc-run
python -m training.pipeline predict --run models/poc-run --input models/poc-prepared/validation.json --output models/poc-predictions.json
```

Preparation writes validated raw rows, source/split provenance and frozen v2
preprocessing. Training deserializes only train and validation after integrity
checks. The self-contained run includes architecture, CPU-safe weights, separate
target transform, preprocessing, median statistics, config/runtime, normalized
history and provenance. A completion manifest with SHA-256 hashes is written
last. Incomplete or incompatible bundles, changed feature order/dimension and
swapped artifacts fail loading. `torch.load` always uses map_location=cpu and
weights_only=True. Reload needs no prepared directory, fitting or RPC access:

```python
from training.bundles import predict_rows
predictions = predict_rows("models/poc-run", eligible_rows)
```

Inference rows need the ordered eligible fields only (no gasUsed/receipts); caller
must supply valid pre-execution quantities and document reference-state timing.
JSON is an inference/prepared intermediate, never an additional extraction source.

After selecting the run, explicitly evaluate once:

```sh
python -m training.pipeline evaluate --run models/poc-run --prepared models/poc-prepared
python -m training.pipeline evaluate --run models/poc-run --prepared models/poc-prepared --verify
```

Evaluation verifies model/data fingerprints before deserializing final labels.
Validation diagnostics, temporal test and unseen-contract test remain separate.
Both estimators use identical row identities. Reports contain gas-unit MAE/RMSE,
dimensionless R², contract/selector counts/errors and fallback counts. R² is null
with a reason for singleton/constant targets. Groups below 10 rows are flagged
as rare (a reporting convention, not a validity threshold). Aligned CSV files
retain actual gas, both predictions and residuals (actual minus prediction).
Matplotlib PNG plots show actual versus predicted for each estimator, with the
identity line. Evaluation never refits anything. Existing evaluation is refused;
`--verify` checks unchanged artifacts and recomputes unchanged results without
overwriting, returning verification_only=true. Incomplete evaluations also refuse
overwrite. Final scores must not guide further tuning of this experiment: reserve
a new future test window for a new experiment. Short coverage, rare functions and
one unseen contract limit conclusions even for the primary collection.

Run the separate local 11-row diagnostic (requires that extraction, no RPC):

```sh
python -m training.pipeline smoke --output models/usdc-smoke
```

It performs prepare/train/save/reload/evaluate in separate directories, trains at
most 10 epochs and marks metrics, prediction tables and plots as
`pipeline_check_only=true`. Its 1/5/5 row split cannot support performance claims.
No final-test score is an acceptance threshold or a tuning signal.

Offline verification needs no local extraction or credentials:

```sh
python -m unittest discover -s training -t . -v
ruff check training
ruff format --check training
```

Tests generate temporary Parquet fixtures (including four separate poc windows).
They are verification data, never synthetic observations in the real experiment.
Legacy snapshot integrity tests verify the immutable released hashes.

In Colab, clone/upload this repository and upload **only** the four complete
`poc-v3` extraction directories with their manifests and listed Parquet parts
under `data/extractions/poc-v3`. Run cells from the repository root:

```python
%pip install -r training/requirements.txt
!python -m training.pipeline prepare --mode poc --output models/poc-prepared
!python -m training.pipeline train --prepared models/poc-prepared --output models/poc-run
```

After reviewing validation history and freezing the selected run, use a separate
cell exactly once; save/download the entire run directory to retain provenance:

```python
!python -m training.pipeline evaluate --run models/poc-run --prepared models/poc-prepared
```

The pinned Torch version needs a compatible wheel/runtime; CPU is the verified
default. GPU use is optional via `--device cuda`, subject to deterministic Torch
support and the documented platform limitations.
