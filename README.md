# Atlas GasNet

Atlas GasNet is an academic proof of concept for predicting the gas consumed by an EVM transaction (`gasUsed`) before execution results are known.

The project treats gas-consumption prediction as a supervised regression problem. The planned model is a PyTorch multi-layer perceptron (MLP) trained on transaction and receipt data collected from Ethereum Mainnet.

## Planned architecture

- **Extraction:** TypeScript and [viem](https://viem.sh/) for bounded historical direct calls, receipt retrieval, validated RPC fallback, and resumable Parquet output.
- **Data preparation:** Python with Pandas and NumPy.
- **Modeling:** PyTorch for the MLP and scikit-learn for evaluation metrics.
- **Storage:** Parquet datasets, with Google Colab available for experimentation and training. CSV export is deferred.

The initial proof of concept will focus on a small, documented set of smart contracts and functions. Features must be available before execution and must not leak post-execution information into the prediction.

## Academic objective

This repository supports the Advanced Artificial Intelligence course at UTN FRBA. It will document a reproducible data-collection workflow, baseline, MLP experiments, evaluation, and limitations.

## Status

**Proof of Concept — historical extractor implemented; modeling planned.**

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

Rerun the same command to resume. See [docs/extractor.md](docs/extractor.md) for configuration, public endpoint verification limits, data semantics, tests and checkpoint behavior. No training runs automatically.

See [docs/PROJECT.md](docs/PROJECT.md) for scope, methodology, and constraints.
