# Tasks

## 1. Historical state enrichment

- [x] 1.1 Add validated opt-in settings, historical balanceOf routing and enrichment; document configuration and failure policy. Verify deterministic unit cases for zero/positive balances, equal/unequal amounts, zero amount, self transfer, invalid calldata, other functions, disabled contracts, previous block/genesis, exact large integers, unavailable history, retries, fallback, network validation and sanitized failures.
- [x] 1.2 Integrate schema 2 candidates/audit fields, manifest policy, PDF coverage and runner/checkpoint persistence; document roles, migration and methodological limitations in English. Verify unit and integration tests for JSON/Parquet exactness and nullability, failed/complete/not-applicable rows, compatible resume, rejected old schema/changed settings, format changes and disabled behavior.

## 2. Integration verification

- [x] 2.1 Run formatting, typecheck, build, full deterministic tests and strict OpenSpec validation; inspect final diff and verify example data is unchanged. Record results and limits without live extraction or model training.

## 3. Transfer model inputs extension

- [x] 3.1 Add tokenAmount, isZeroAmount, isSelfTransfer, senderHasEnoughBalance and exact rational amountToSenderBalanceRatio using existing balance reads. Document derivation and missingness; verify unit cases for distinct/self addresses, zero amounts/balances, sufficient/insufficient funds, failed history, invalid/non-applicable calldata, repeating fractions, uint256 bounds and unchanged RPC count/receipt independence.
- [x] 3.2 Version schema 3 and manifest ratio policy, update exports/PDF/docs/config and verify JSON/Parquet/CLI round trips, null versus zero ratio, format regeneration, resume and rejection of schema-1/2 checkpoints without writes. Run full checks and strict OpenSpec validation; record results without extraction or training.

Verification: the full check passed 235 tests across 17 files (70 new unit cases);
strict OpenSpec validation and diff whitespace checks passed. The full disk/CLI
suite ran outside the Windows sandbox after its known temporary-file rename EPERM.
No live extraction or training ran. Existing example part checksums still match
their manifest; the user lifted example immutability, but regeneration was unnecessary.

The transfer extension uses schema 3, preserves exact rational ratios and valid
calldata fields after historical-state failure, and reuses existing state reads.
Allowance remains outside the supported enrichment scope. The final full check was
resumed successfully after automatic approval review had been unavailable due to
the account usage limit; no check failure remains outstanding.
