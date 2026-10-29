# E3 extraction interruption, 2026-10-29

The Full run completed train (155435 rows), validation (39111) and test (59504).
The last stage, unseen-contract, stopped at 13:30:11.909 UTC after 6082.5 seconds
(1 hour, 41 minutes, 22.5 seconds). It had committed 34 batches / 3400 blocks /
42560 rows and was processing batch 19050900–19050999. Its checkpoint resumes at
19050900; the preceding work does not need to be collected again.

The log `models/extraction-logs/e3-20261029-000942-345-unseen-contract.log`
records `rpc_rejected operation=receipt endpoint=1` for blocks 19050936,
19050955 and 19050954 immediately before the failure. The profile used only
`https://eth.drpc.org`, so there was no second endpoint to try. The old rejection
path handled invalid responses or structured permanent provider errors; it did
not retain enough diagnostic detail to distinguish them. In particular, the
evidence does **not** establish a rate limit, a null receipt, or a particular
transaction as the original cause.

The old CLI discarded the exception and printed a generic error. Windows
PowerShell with ErrorActionPreference=Stop then treated native stderr as a
NativeCommandError before the script could inspect LASTEXITCODE. That PowerShell
message was secondary to the extractor failure.

Read-only verification subsequently retrieved all 126 selected receipts in those
three blocks successfully. An isolated extraction of 19050936–19050955 completed
with 261 rows in 16.8 seconds, no RPC retries and no failed enrichments. Its output
is under `data/extractions/e3-recovery-verification-2026-10-29/`, separate from E3
training/test data. This supports a transient provider failure; it cannot recover
the original response which was never recorded.

## Recovery changes

The subsequent continue-on-error update makes per-item continuation the default:
blocks/receipts that exhaust their retries go to `errors.json`, successful rows
are saved, and the scan continues through the remaining batches and E3 stages.
The manifest distinguishes `scanComplete: true` from `complete: true` and exposes
the number of pending errors. Repeating the command repairs affected batches
without replaying already successful batches. `continueOnError: false` restores
the strict whole-batch recovery behavior described below. See
[the extractor guide](extractor.md) for current defaults and checkpoint details.

- Null receipts receive bounded request retries rather than immediate invalid-data
  rejection. Other inconsistent responses still fail validation and can fall back
  to the next configured RPC.
- RPC exhaustion includes structured status/code/category, validation reason,
  endpoint index, operation, block and receipt transaction hash.
- The runner retries failed RPC batches with fresh rows and enrichment state;
  committed batches stay untouched. No missing receipts or bad rows are accepted.
- Defaults are batchRetries=3 and batchRetryDelayMs=5000 (exponential delay capped
  at one minute). Configuration, write errors, authorization errors and an
  inconsistent resume hash stop without batch retries.
- After exhaustion, exit code 2 allows the PowerShell runner to resume the same
  stage up to two more times with 30-second pauses. Exit code 1 stops it.
- PowerShell captures stderr and appends every attempt to the stage log. CLI
  failure logs and final RPC metrics are retained without logging provider URLs,
  credentials or raw error messages.

Resume just the unfinished stage from the repository root:

```powershell
.\scripts\run-e3-extraction.ps1 -Phase Full -Stages unseen-contract
```

The original `-Phase Full` command is also compatible: completed stages use their
existing checkpoints and regenerate exports before the unfinished stage resumes.
Keep each stage's config selection, output directory, checkpoint and committed
parts. Optional alternate RPC URLs can be supplied with `-RpcConfig`; failover
requires more than one working endpoint in that profile.

Offline regression tests cover null-receipt recovery through the real viem HTTP
adapter, batch backoff/exhaustion, no retry for permanent/application errors,
replaying a partially processed batch without duplicates, and native stderr/exit
code handling through Windows PowerShell with a simulated npm.cmd.
