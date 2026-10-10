# Atlas GasNet

Atlas GasNet is an academic proof of concept for predicting the gas consumed by an EVM transaction (`gasUsed`) before execution results are known.

The project treats gas-consumption prediction as a supervised regression problem. The planned model is a PyTorch multi-layer perceptron (MLP) trained on transaction and receipt data collected from Ethereum Mainnet.

## Planned architecture

- **Extraction:** TypeScript and [viem](https://viem.sh/) for Ethereum RPC access, transaction discovery, and receipt retrieval.
- **Data preparation:** Python with Pandas and NumPy.
- **Modeling:** PyTorch for the MLP and scikit-learn for evaluation metrics.
- **Storage:** CSV or Parquet datasets, with Google Colab available for experimentation and training.

The initial proof of concept will focus on a small, documented set of smart contracts and functions. Features must be available before execution and must not leak post-execution information into the prediction.

## Academic objective

This repository supports the Advanced Artificial Intelligence course at UTN FRBA. It will document a reproducible data-collection workflow, baseline, MLP experiments, evaluation, and limitations.

## Status

**Planning / Proof of Concept**

The repository currently contains project documentation and planning only. The extractor, model, training pipeline, and datasets will be added in subsequent tasks.

See [docs/PROJECT.md](docs/PROJECT.md) for scope, methodology, and constraints.
