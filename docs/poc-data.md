# Real Ethereum data for the PoC

Run the following commands **from the repository root**, after installing the
extractor dependencies (`npm --prefix extractor ci`). These selections retrieve
historical mainnet transactions; they do not submit transactions or train a model.

```sh
npm --prefix extractor run extract -- --config config/extraction.poc.train.yaml --rpcs config/rpcs.poc.yaml
npm --prefix extractor run extract -- --config config/extraction.poc.validation.yaml --rpcs config/rpcs.poc.yaml
npm --prefix extractor run extract -- --config config/extraction.poc.test.yaml --rpcs config/rpcs.poc.yaml
npm --prefix extractor run extract -- --config config/extraction.poc.unseen-contract.yaml --rpcs config/rpcs.poc.yaml
```

The last command is an additional final evaluation dataset. Keep its results
separate from the ordinary temporal test. Every configuration enables Parquet,
JSON and PDF and writes to its own directory under `data/extractions/poc-v3/`.
Parquet and JSON contain the same observations; do not concatenate both formats
as if they were different training examples. PDF is a summary, not model input.

## Fixed selection and split

All ranges are inclusive and use Ethereum Mainnet (chain ID 1).

| Configuration                         | Blocks            | Block count | Contracts   | Output directory suffix |
| ------------------------------------- | ----------------- | ----------- | ----------- | ----------------------- |
| `extraction.poc.train.yaml`           | 19000000–19001439 | 1440        | USDC, WETH9 | `train`                 |
| `extraction.poc.validation.yaml`      | 19001440–19001799 | 360         | USDC, WETH9 | `validation`            |
| `extraction.poc.test.yaml`            | 19001800–19002399 | 600         | USDC, WETH9 | `test`                  |
| `extraction.poc.unseen-contract.yaml` | 19001800–19002399 | 600         | USDT only   | `unseen-contract`       |

The ordinary split is chronological, with 60% / 15% / 25% of **blocks**; actual row
proportions depend on activity. Train, validation and temporal test have no block
overlap and use identical contract/function filters. The additional USDT test
shares the temporal test window but has disjoint transactions and a contract
absent from both training and validation. Do not mix it into the ordinary split.

Verified RPC timestamps:

| Boundary block | UTC timestamp       |
| -------------- | ------------------- |
| 19000000       | 2024-01-13 19:17:23 |
| 19001439       | 2024-01-14 00:06:35 |
| 19001440       | 2024-01-14 00:06:47 |
| 19001799       | 2024-01-14 01:19:11 |
| 19001800       | 2024-01-14 01:19:23 |
| 19002399       | 2024-01-14 03:19:35 |

This is an initial experiment within approximately eight hours of historical
activity. It does not measure robustness across months, protocol upgrades or
arbitrary DeFi/NFT contracts. A later experiment should predefine a broader time
window and more contract families, with its own untouched evaluation set.

## Contracts and functions

Addresses and interfaces were checked against issuer documentation/source:

- [Circle USDC addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses):
  `0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48`.
  Select `transfer(address,uint256)`, `transferFrom(address,address,uint256)` and
  `approve(address,uint256)`; see [Circle source](https://github.com/circlefin/stablecoin-evm/blob/master/contracts/v1/FiatTokenV1.sol).
- [Canonical WETH9](https://www.weth.io/):
  `0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2`.
  Select the same three signatures plus `deposit()` and `withdraw(uint256)`;
  see [WETH9 source](https://github.com/gnosis/canonical-weth/blob/master/contracts/WETH9.sol).
- [Tether supported protocols](https://tether.to/en/supported-protocols/):
  `0xdac17f958d2ee523a2206206994597c13d831ec7`.
  Select `transfer`, `transferFrom` and `approve` with the same signatures as above,
  exclusively for the unseen-contract evaluation.

Only top-level direct calls to these addresses are collected. Token transfers
inside routers and other internal calls are outside this extractor's scope.
There is no event-topic filter, so reverted transactions are not deliberately
removed by requiring a successful event. WETH calls with empty calldata are
outside the explicit function selection, even when they wrap ETH.

## Expected volume and coverage

A read-only probe sampled 24 full blocks at heights `19000000 + 100 * i`, for
`i = 0..23`, on 2026-10-19. It observed:

| Contract | transfer | transferFrom | approve | deposit | withdraw | Total |
| -------- | -------- | ------------ | ------- | ------- | -------- | ----- |
| USDC     | 60       | 1            | 13      | —       | —        | 74    |
| WETH9    | 0        | 0            | 7       | 10      | 8        | 25    |
| USDT     | 187      | 15           | 33      | —       | —        | 235   |

Uniform extrapolation gives roughly **9,900** ordinary observations across all
three splits (about 5,940 training) and **5,875** USDT observations in the additional
600-block test. These are rough planning estimates from a small systematic sample,
not extracted totals or statistical guarantees. Most rows will likely be transfers;
some selected functions may have few or zero examples. Extra configured functions
alone do not establish coverage or improve generalization.

After extraction, inspect each `manifest.json` row count and `report.pdf` groups.
Report counts and errors by contract/function, alongside aggregate MAE/RMSE/R².
Rare groups cannot support strong conclusions. Assess training adequacy with
learning curves using training and validation only. If coverage is inadequate,
define a new collection version and new future final-test windows before tuning;
never move existing test rows into training to improve a reported score.

## RPC availability and state features

Use `config/rpcs.poc.yaml` explicitly: at verification time dRPC served the
boundary blocks, a USDC receipt at block 19000000 and the sender's `balanceOf` at 18999999. The receipt transaction was
`0x0ea4a96a24aca17cf18c2ebc9ba7d5f5a2738dc8eae83bac9b07ccea74010249`
(gas used 40348). PublicNode served blocks but returned a null receipt for that
transaction and required a personal token for that historical state request.
These probes do not establish availability for every row, contract or balance.

A one-block CLI smoke extraction with all three contract selections completed at
19000000: 14 rows (2 USDC and 12 USDT), 12 complete enrichments and 2 non-applicable
calls. JSON and decoded Parquet both contained 14 rows; the generated PDF loaded
successfully with 3 pages. There were no selected WETH calls in that block, so this
smoke run does not verify its end-to-end coverage. Generated smoke artifacts are
local only, under `data/extractions/poc-verification/`. The four full collection
runs have not been executed.

Public endpoint limits and archival access can change. Extraction may take time
because it reads blocks, receipts and optional balances. Batches contain 25 blocks
to limit repeated work after interruption. Rerun the identical command to resume;
if you change the selection, choose a new output directory. Check completeness
before training; do not treat an interrupted extraction as the complete split.

The selections use `rpcConcurrency: 4` for bounded parallel reads. Run the commands
sequentially on the public endpoint: the limit is per process. Console logs show
scanned and committed block progress, receipts/enriched rows, retries and elapsed
time. Only committed block coverage counts toward `percent`; scanning can be ahead.
You can change concurrency (1–32) and resume with the same output directory. See
[concurrency and progress](extractor.md#concurrency-and-console-progress) for details.

All four selections enable ERC-20 enrichment, but the current implementation
enriches only canonical `transfer(address,uint256)` calls. Other functions have
`not_applicable` status and null transfer/state candidates. Historical-state
failures remain explicit nulls; they are not zero balances. Check coverage by
split/contract/function and use a consistent missing-value policy. Preceding-block
balances are approximate pre-transaction state; earlier activity within the
inclusion block can change balances. See [extractor.md](extractor.md#optional-erc-20-historical-balances).

## Training and evaluation rules

Fit scalers, imputers, vocabulary/encoders and all feature selection on training
only. Tune hyperparameters and early stopping using validation. Keep both final
test sets untouched until the model and preprocessing are frozen. Deduplicate by
chain ID and transaction hash. Keep `gasUsed` as the regression target; exclude
receipt outcomes, log-derived features and other post-execution fields from
predictor inputs. Review block-derived inputs for availability at submission time.

Contract addresses and function selectors are categorical identifiers, not numeric
magnitudes. The USDT test requires an explicit unknown-contract encoding learned
without fitting on test data. Fit amount transformations on training only; raw
token base-unit amounts are not directly comparable across tokens with different
decimals. Compare against the median-by-function baseline and document fallback
behavior for unseen groups. Never use held-out target medians as a fallback.

Diversifying contracts and functions can broaden the learned behavior, but does
not guarantee improvement. The temporal test measures future calls to known
contracts; the separate USDT test measures transfer to one unseen implementation
of familiar interfaces. Neither establishes generalization to arbitrary contracts
or functions absent from training. This change supplies collection configurations;
it does not implement preprocessing, model training or evaluation.
