# Colab input data

`poc-v3.zip` contains the four schema-3 extraction manifests and their Parquet
parts: 7,195 training, 1,373 validation, 2,466 temporal-test and 4,903 USDT rows.
These are public Ethereum Mainnet transaction records. No RPC account, extractor,
API key or permission request is required to run the Python notebook.

Archive SHA-256: `24af4d8d7f701f4a1eb96336526a3b4f93ffa89e68e89d106fc6b7306a37d824`.

Individual part hashes are verified by `training.pipeline prepare` before use.
The JSON/tensor release in `data/poc/v1` remains unchanged.
