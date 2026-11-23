# Genetic-programming gas regressor

`training.symbolic.GasSymbolicRegressor` is the second model alongside the existing
PyTorch MLP. It uses gplearn's tree-based genetic programming to learn a symbolic
expression for transaction `gasUsed`. This is an evolutionary regressor, not
genetic tuning of the MLP. The engine runs on CPU and needs no GPU.

Genetic Programming was accepted as the second technique on 2026-11-22.
The standalone interface below remains available. The [E3 experiment](e3-experiment.md)
integrates this model with training-only preparation, validation-based candidate
selection, portable JSON persistence and held-out comparison against MLP and the
selector-median baseline. E2 datasets and retained results remain separate.

## Installation

From the repository root, with Python 3.12+, install the optional requirements:

```sh
python -m pip install -r training/requirements-symbolic.txt
```

This includes the existing training requirements plus `gplearn==0.4.3`. The MLP's
base requirements do not acquire this optional dependency. The same installation
works in a compatible Google Colab Python environment; fitting is never automatic.

## Model interface

The caller supplies a finite, already prepared numeric matrix with stable column
order. `y_train` contains positive receipt gas labels in original gas units.
Do not feed raw transaction dictionaries or every exported field into the model.

```python
from training.symbolic import GasSymbolicRegressor, SymbolicConfig

# X_train, y_train, X_new and feature_names come from the caller's frozen
# training-only preprocessing. This snippet does not load or split any dataset.
model = GasSymbolicRegressor(SymbolicConfig(seed=42))
model.fit(X_train, y_train, feature_names=feature_names)
predictions = model.predict(X_new)  # shape (N,), gas units
print(model.expression_)
```

Use the same eligible information as the MLP when comparing algorithms. Receipts
provide labels only; receipt outcomes, execution traces, actual inclusion context
and audit reasons are not predictors. The caller must enforce these constraints,
feature ordering, train-only preprocessing and separation of held-out data.
NumPy arrays obtained from prepared CPU PyTorch tensors can be passed directly.

## Behavior and limitations

- The model predicts gasUsed directly, not a residual, gas price or a safe gas limit.
- Target mean and population standard deviation are fitted only on the supplied
  training labels. Constant labels use unit scale. Predictions invert this
  normalization without refitting, clipping or rounding.
- Evolution uses MAE in normalized target units, tournament selection, crossover
  and mutation. A parsimony coefficient penalizes expression length during
  selection; it is not a hard maximum on the final formula's length or depth.
- Supported operators are addition, subtraction, multiplication, protected
  division, absolute value, minimum and maximum. In gplearn protected division
  returns 1 when the denominator's absolute value is at most 0.001.
- The fixed seed and single worker support repeatability in the same environment.
  Defaults are starting values, not tuned findings or performance claims.
- `expression_` includes the inverse target transform, but gplearn rounds displayed
  internal constants. It is for inspection only: use `predict` for inference.
  Never `eval` the expression or treat it as an exact serialization format.
- Arbitrary feature values can yield negative predictions; these are deliberately
  visible. Nonfinite inputs or predictions fail explicitly. A future experiment
  must define and evaluate any output constraints rather than adding silent clips.
- The standalone class does not perform validation selection. E3 orchestration
  selects among explicit candidate configurations by validation gas-unit MAE,
  breaking ties by candidate order. Evolution within each candidate still uses
  training fitness, without validation-based generation stopping.
- Selected programs persist as validated JSON prefix trees, with exact constants,
  feature order and training target scaling. Reload/predict needs no gplearn,
  pickle or expression evaluation. Generation OOB fitness is null when unavailable
  because training uses every row; it is not an additional holdout score.

## Unit verification

```sh
python -m unittest training.test_symbolic -v
ruff check training/symbolic.py training/test_symbolic.py
ruff format --check training/symbolic.py training/test_symbolic.py
```

Tests use small synthetic fixtures to verify behavior only; they are not training
observations or experiment results. Evolution tests skip when the optional engine
is absent; install the optional requirements to execute them.
