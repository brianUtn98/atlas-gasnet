# Ethereum PoC dataset v1

This versioned snapshot contains **15,937 distinct real Ethereum Mainnet direct
calls**, collected on 2026-10-20 from blocks produced on 2024-01-13/14 UTC. It is
the explicitly approved dataset release; local extraction runs remain ignored.

| Split | Rows | Inclusive blocks | Contracts | Role |
| --- | ---: | --- | --- | --- |
| `train` | 7,195 | 19000000–19001439 | USDC, WETH9 | Fit preprocessing and model |
| `validation` | 1,373 | 19001440–19001799 | USDC, WETH9 | Tune and early-stop |
| `test` | 2,466 | 19001800–19002399 | USDC, WETH9 | Final temporal evaluation |
| `unseen-contract` | 4,903 | 19001800–19002399 | USDT | Additional final evaluation |

The temporal split uses 60% / 15% / 25% of blocks; row proportions differ with
activity. The two final test sets share a time window and have disjoint contracts
and transaction identities. The separate 11-row example is excluded because it
overlaps training. Test data must stay outside training, preprocessing fitting,
feature selection and hyperparameter tuning.

## Files and loading

Each split has an exact original `SPLIT.json` array and a `SPLIT.pt` tensor bundle.
`manifest.json` records row counts, source fingerprints, coverage and SHA-256 hashes.
`preprocessing.json` records the fixed feature order, category vocabularies and
training-only numeric statistics. `provenance/` retains extraction manifests;
their original Parquet part names/hashes describe source files kept locally,
not additional files needed to load this snapshot. No RPC requests are needed.

From the repository root, with Python 3.12+:

```sh
python -m pip install -r training/requirements.txt
```

For a CPU-only installation:

```sh
python -m pip install numpy==2.5.4
python -m pip install torch==2.14.1 --index-url https://download.pytorch.org/whl/cpu
```

```python
from torch.utils.data import DataLoader
from training.dataset import GasDataset

train = GasDataset("train")
validation = GasDataset("validation")
temporal_test = GasDataset("test")
unseen_test = GasDataset("unseen-contract")

train_loader = DataLoader(train, batch_size=64, shuffle=True)
validation_loader = DataLoader(validation, batch_size=256, shuffle=False)
test_loader = DataLoader(temporal_test, batch_size=256, shuffle=False)
unseen_loader = DataLoader(unseen_test, batch_size=256, shuffle=False)

X_batch, y_batch = next(iter(train_loader))
input_dimension = len(train.feature_names)
```

The loader verifies hashes and uses `torch.load(..., map_location="cpu",
weights_only=True)`. See the official [Dataset/DataLoader tutorial](https://docs.pytorch.org/tutorials/beginner/basics/data_tutorial.html)
and [serialization tutorial](https://docs.pytorch.org/tutorials/beginner/saving_loading_models.html).

Tensor bundle keys:

| Key | Meaning |
| --- | --- |
| `X` | Float32 standardized inputs, optional-state missing indicators and one-hot categories |
| `X_baseline` | Float32 inputs restricted to the extractor's seven initial predictors |
| `y` | Float32 unscaled `gasUsed`, shape `[N, 1]` |
| `gas_used` | Exact original gas target as int64, shape `[N, 1]` |
| `row_ids` | Chain ID plus transaction hash, aligned with tensor rows and JSON order |
| `block_number`, `transaction_index` | Int64 audit tensors; never included in `X` |
| `feature_names`, `baseline_feature_names` | Ordered input-column names |
| `preprocessing_sha256` | Identity of the fitted preprocessing artifact |

Use `GasDataset("train", baseline=True)` and the same option for every other split
to compare a model without historical state features. Choose feature settings and
model parameters using train/validation only. This release does not include a
trained model or model-performance claims.

## Predictor policy

Baseline inputs are `chainName`, contract `to`, `functionSelector`, `calldataBytes`,
`calldataNonzeroBytes`, native `value` and `accessListStorageKeyCount`. Contract and
selector identifiers are categorical; vocabularies come exclusively from training
and include an explicit unknown column. USDT maps to the unknown-contract column.

The extended inputs additionally use the nine exported transfer/state candidates:
token amount, zero/self-transfer flags, reference-balance sufficiency, exact-ratio
candidate, sender/recipient balances, recipient-balance-zero and sender-balance-
equals-amount. See `preprocessing.json` for their exact column names.

Amounts, balances, native value, ratio and access-list key counts use `log1p`;
calldata counts and binary indicators keep their numeric scale before
standardization. Fit the median, mean and population standard deviation on
training only. Missing optional values receive the transformed training median
and a separate missing indicator. Constant numeric columns use scale 1. Every
other split uses these frozen values, without clipping or refitting.

Raw JSON preserves exact decimal strings and rational ratios. Numeric transforms
and float32 tensors intentionally approximate quantities for the neural network.
Token amounts remain token base units, native value remains wei; token decimals
differ (USDC/USDT versus WETH). Contract context is encoded, but quantities must
not be interpreted as a common economic amount across tokens.

Receipt outcomes, audit statuses/reasons, gas price/fee fields, sender identity,
block hashes/heights/timestamps and transaction IDs are excluded from model inputs.
`gasUsed` appears only as the target. Original JSON keeps audit fields for checking
provenance; do not automatically treat every JSON column as a predictor.

## Coverage and limitations

There are **16 `invalid_calldata` enrichment failures**: 8 train, 1 validation,
7 unseen-contract. These observations remain in the dataset with null balance
candidates. Other functions have `not_applicable` enrichment and expected nulls.
There were no `historical_state_unavailable` rows in the published collection.
Missing balance is never a zero balance.

Balances refer to the end of the previous block, an approximation to transaction
pre-state. Earlier same-block activity can change balances. A real predictor must
use a reference block available before execution and evaluate that mismatch.
The strict decoder's applicability and RPC failure policy are documented in
[the extractor guide](../../../docs/extractor.md#optional-erc-20-historical-balances).

This is a narrow historical window of direct token-contract calls; it does not
cover internal calls or general DeFi/NFT programs. WETH `transferFrom` has no
training observations and one validation observation. Report support and errors
by contract/function; the unseen-contract set evaluates only one unseen token
implementation and does not establish universal generalization.

## Rebuild and verification

The preparer validates complete manifests, source part hashes, row order, ranges
and disjoint transaction identities. It copies JSON bytes unchanged, fits only on
training, creates tensors and verifies a serialization round trip.

```sh
# Requires the original local extraction directories. Choose a new output path.
python -m training.prepare_dataset --output data/poc/rebuilt-v1

# Checks the committed snapshot, train-only fitting, row alignment, unknown/missing
# handling, leakage exclusions and a train-batch regression backward pass.
python -m unittest training.test_dataset -v
```

Keep this released version immutable. Use a new version for changed selection,
features or preprocessing. Raw blockchain facts are public; this release contains
no private RPC credentials, signed transactions, model weights or execution logs.
