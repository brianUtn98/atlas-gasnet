# E3 data collection

The four local extraction manifests now report complete collection: 155,435 train,
39,111 validation, 59,504 temporal-test and 145,124 USDT rows (399,174 total).
These counts describe coverage, not prediction performance. Commands below
document collection and recovery; no new extraction is required for preparation.

## Scope

Use Ethereum Mainnet, the same USDC/WETH9 functions as E2, and a separate USDT
holdout. Fixed inclusive bounds cover 50,000 distinct blocks, approximately one
week. Keeping these contracts/functions makes the MLP and genetic-programming
comparison easier to interpret. This does not establish robustness across months
or protocol upgrades.

| Stage            | Inclusive blocks  | Blocks | Contracts   |
| ---------------- | ----------------- | -----: | ----------- |
| Training         | 19010000-19039999 |  30000 | USDC, WETH9 |
| Validation       | 19040000-19047499 |   7500 | USDC, WETH9 |
| Temporal test    | 19047500-19059999 |  12500 | USDC, WETH9 |
| Contract holdout | 19047500-19059999 |  12500 | USDT        |

Training, validation and temporal test allocate 60/15/25 percent of blocks.
The USDT stage scans the test window separately, so the four commands perform
62,500 block reads before retries, resume checks and the pilot. E2 ends at
19002399; none of these intervals overlap it. USDT never enters training or
validation. Preserve the E2 release and its final-test observations separately.

Linear extrapolation from E2's 11,034 ordinary rows over 2,400 blocks and 4,903
USDT rows over 600 test blocks suggests roughly 230,000 ordinary rows plus
102,000 USDT rows. This is a planning estimate, not a measured total or guarantee.
Activity and function proportions can change. More rows alone will not repair
missing predictors for the functions that currently have high errors.

## Pilot, then unattended collection

Install dependencies once if they are not installed:

```powershell
npm.cmd --prefix extractor ci
```

Run a 250-block operational pilot within the training interval:

```powershell
.\scripts\run-e3-extraction.ps1 -Phase Pilot
```

Before the full run, check `data/extractions/e3-v1-pilot/manifest.json` has
`complete: true`, and inspect `transactions.json` for counts by contract/function
and `stateEnrichmentStatus`. For eligible transfers, investigate a high share of
`failed` historical reads before scaling up. `not_applicable` is expected for
other functions; it is not an RPC failure. Use elapsed time and committed block
throughput in the log to revise the duration estimate. USDT is denser than the
ordinary selection, so a simple pilot multiplier is approximate.

After reviewing the pilot:

```powershell
.\scripts\run-e3-extraction.ps1 -Phase Full
```

The script runs the four stages sequentially and stops on an error or incomplete
manifest. Rerunning the identical command resumes committed progress. Logs are
under `models/extraction-logs/`. Keep the computer powered, online and awake.

The pilot is saved separately and overlaps training. Do not append its rows as
additional observations; the full training stage will read those blocks again.

## Operational choices and validation status

- Main stages: batchSize 100, rpcConcurrency 4, retries 3, probe timeout 10 seconds.
- Pilot: batchSize 25 for more frequent committed progress.
- Parquet parts and a readable JSON array are requested. The same observations
  occur in both formats; never concatenate the formats as independent examples.
- Concurrency is an in-flight limit, not an RPS guarantee. One process at a time
  avoids multiplying the provider load. If repeated throttling occurs, lower
  rpcConcurrency to 2 and resume.
- Batch size is a checkpoint boundary, not JSON-RPC request batching. Keep it
  unchanged after a run starts; resume uses the existing committed part layout.
- Custom RPC profiles can be passed with `-RpcConfig config/rpcs.local.yaml`.

Read-only probes on 2026-10-28 at the configured public dRPC endpoint returned
chain ID 1, both boundary blocks, a selected USDC/WETH9 transfer receipt at the
first block, and a 32-byte historical sender balance at block 19009999. Boundary
timestamps were 2024-01-15 04:49:11 UTC and 2024-01-22 04:47:23 UTC. These checks
are point samples, not assurance for the whole campaign or sustained throughput.
Public rate limits apply: https://drpc.org/docs/howitworks/ratelimiting .

The current enrichment decodes transfer amounts and balances only for canonical
`transfer(address,uint256)`. approve, transferFrom, deposit and withdraw keep
their optional transfer/state fields absent. Extra collection increases their
sample counts but does not add allowance or contract-state predictors.

## Integration with the models

Collecting data does not train either model. Python `prepare --mode poc` keeps
the original E2 policy; `prepare --mode e3` accepts the new campaign separately.
E3 validates manifest bounds, contiguous 60/15/25 block splits, matching ordinary
filters, separate USDT over the test window and transaction disjointness. It fits
transforms on E3 training only. MLP and symbolic use identical inputs and row
identities; see the [experiment commands and notebook](e3-experiment.md).

The temporal/USDT test files may be collected in advance, but their labels and
scores stay outside fitting, feature decisions and parameter selection until
models are frozen. Quality checks on test coverage do not authorize tuning on
its prediction errors.
