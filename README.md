# Atlas GasNet

Atlas GasNet is an academic proof of concept for predicting the gas consumed by an EVM transaction (`gasUsed`) before execution results are known.

The project treats gas-consumption prediction as a supervised regression problem. A PyTorch multi-layer perceptron (MLP) is trained on pre-execution transaction features collected from Ethereum Mainnet; receipts provide the target consumption only.

## Architecture

- **Extraction:** TypeScript and [viem](https://viem.sh/) for bounded historical direct calls, receipt retrieval, validated RPC fallback, and resumable Parquet output.
- **Data preparation:** Python with Pandas and NumPy.
- **Modeling:** PyTorch for the MLP and scikit-learn for evaluation metrics.
- **Storage:** Parquet datasets, with Google Colab available for experimentation and training. CSV export is deferred.

The initial proof of concept will focus on a small, documented set of smart contracts and functions. Features must be available before execution and must not leak post-execution information into the prediction.

## Academic objective

This repository supports the Advanced Artificial Intelligence course at UTN FRBA. It will document a reproducible data-collection workflow, baseline, MLP experiments, evaluation, and limitations.

## Status

For the academic submission, open [the Python notebook in Google Colab](https://colab.research.google.com/github/brianUtn98/atlas-gasnet/blob/work/notebooks/atlas_gasnet_colab.ipynb).
It downloads the published data, prepares the inputs, trains the MLP and evaluates
the temporal and USDT test sets. It does not execute the TypeScript extractor or
require RPC credentials. The [Colab data archive](data/colab/README.md) contains
the original Parquet inputs and their manifests.

The [versioned PoC dataset](data/poc/v1/README.md) contains 15,937 real Ethereum
transactions in four disjoint train/validation/test/unseen-contract partitions,
with original JSON and PyTorch `.pt` tensors. Load it without RPC access:

```python
from torch.utils.data import DataLoader
from training.dataset import GasDataset

train_loader = DataLoader(GasDataset("train"), batch_size=64, shuffle=True)
```

Install `training/requirements.txt` with Python 3.12+ first. The dataset card
documents train-only preprocessing, missing-state indicators, baseline inputs and
the held-out evaluation policy. Verify with
`python -m unittest training.test_dataset -v`. Python formatting/lint uses Ruff:
install `training/requirements-dev.txt`, then run `ruff format training` and
`ruff check training`.

The [offline training guide](docs/training.md) provides verified Parquet preparation,
the PyTorch MLP, median-by-function baseline, portable runs and explicit held-out
evaluation, with deterministic temporary-Parquet tests and Colab commands.

A separate [genetic-programming regressor](docs/symbolic-model.md) provides a
standalone fit/predict interface and formula inspection for the second model;
its experiment and new data collection are not yet implemented.

**Proof of Concept — training and final evaluation completed in Colab.**
The [retained experiment](results/colab-2026-10-21/README.md) records a temporal-test
MAE of 1,740.20 gas and a USDT-test MAE of 3,395.39 gas. These results concern the
selected contracts and period; they do not establish accuracy for arbitrary calls.

Extraction supports Ethereum Mainnet/Sepolia, Avalanche C-Chain/Fuji, and Polygon/Amoy. The first ML experiment remains scoped to Ethereum Mainnet; supporting testnets does not authorize pooling their data.

With Node 24 LTS (or a version allowed by extractor/package.json), run from the repository root:

```sh
npm --prefix extractor ci
npm --prefix extractor run build
npm --prefix extractor run extract -- --config config/extraction.yaml
```

The bundled public RPC map needs no credentials. Edit the example selection to choose a fixed range and direct recipients. For an explicit replacement map, copy config/rpcs.example.yaml to config/rpcs.local.yaml, replace placeholders, then run:

```sh
npm --prefix extractor run extract -- --config config/extraction.yaml --rpcs config/rpcs.local.yaml
```

Output formats are selected in the extraction YAML. The repository example enables all three:

```yaml
outputFormats: [parquet, pdf, json]
```

For development, `npm --prefix extractor run format` applies Prettier and
`npm --prefix extractor run check` verifies formatting, types, build and tests.
The extractor uses output strategies and separate classes for scanning, normalization,
checkpoint persistence and execution; see the architecture notes in docs/extractor.md.

Parquet contains dataset batches, `transactions.json` contains all normalized rows, and `report.pdf` summarizes gas statistics, selection, grouped results and a transaction sample. Choose any nonempty subset. Rerun the same command to resume and generate the selected formats. See [docs/extractor.md](docs/extractor.md) for configuration, public endpoint verification limits, data semantics, tests and checkpoint behavior. No training runs automatically.

See [docs/PROJECT.md](docs/PROJECT.md) for scope, methodology, and constraints.

For real PoC data, use the [collection guide](docs/poc-data.md): it provides
chronological train/validation/test configurations for USDC and WETH9, plus a
separate USDT unseen-contract test, all with Parquet, JSON and PDF output.

Extraction prints timestamped progress for scanned blocks, receipts, enrichment
and committed batches. `rpcConcurrency: 4` in each selection limits all in-flight
RPC requests per process, including probes; accepted values are 1–32. Independent
reads overlap while checkpoint commits remain ordered. Restart the same command
to resume with a different concurrency limit; see the
[concurrency and progress guide](docs/extractor.md#concurrency-and-console-progress).

Optional ERC-20 balance enrichment adds exact sender/recipient balances at the end
of the block before inclusion, exact token amounts, transfer/state indicators and
an exact rational amount-to-balance ratio. Enable
`erc20BalanceEnrichment: true` and `erc20: true` for each selected token contract;
both default to false when omitted. The repository configuration explicitly enables
both for the USDC sample. RPCs must serve historical state. Missing state is explicit,
never a fictitious zero, and `gasUsed` remains the receipt observation. New runs use
schema 3 and require a new output directory for old checkpoints. See the
[state feature documentation](docs/extractor.md#optional-erc-20-historical-balances)
for configuration, failure semantics and prediction-time limitations.
