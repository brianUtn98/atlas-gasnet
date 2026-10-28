# Genetic-programming gas regressor

`training.symbolic.GasSymbolicRegressor` is the second model alongside the existing
PyTorch MLP. It uses gplearn's tree-based genetic programming to learn a symbolic
expression for transaction `gasUsed`. This is an evolutionary regressor, not
genetic tuning of the MLP. The engine runs on CPU and needs no GPU.

This addition provides model code only. It does not collect data, change the
extractor, run a PoC experiment, select hyperparameters on validation, evaluate
held-out partitions, or modify the released dataset and retained MLP results.
A new extraction and an unconsulted final test window belong to a later experiment.

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
- There is no validation selection, early stopping on validation, persistence
  format, CLI, benchmark, or automatic integration into the MLP pipeline here.

## Unit verification

```sh
python -m unittest training.test_symbolic -v
ruff check training/symbolic.py training/test_symbolic.py
ruff format --check training/symbolic.py training/test_symbolic.py
```

Tests use small synthetic fixtures to verify behavior only; they are not training
observations or experiment results. Evolution tests skip when the optional engine
is absent; install the optional requirements to execute them.
