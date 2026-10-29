import { recoverRpc } from './recovery.js';
import { failureDetails, RpcReadError } from './rpc-errors.js';
import { CheckpointRepository } from './checkpoint.js';
import { Erc20BalanceEnricher } from './enrichment.js';
import type { Selection } from './config.js';
import { TransactionScanner } from './extract.js';
import { ManifestBuilder } from './manifest.js';
import { OutputManager } from './output/manager.js';
import { RowNormalizer, rowKey, type Row } from './rows.js';
import { assertData, type ReadonlyRPC } from './rpc.js';
import { encodeJson } from './serialization.js';
import type { Checkpoint, ExtractionManifest } from './state.js';
import type { Store } from './store.js';
import { silentProgress, type ProgressReporter } from './progress.js';

export { SelectionIdentity } from './identity.js';
export { FileStore } from './store.js';
export type { Store } from './store.js';
export type { Checkpoint, ExtractionManifest, Part } from './state.js';

/** Application service: coordinate extraction, durable progress and output strategies. */
export class ExtractionRunner {
  private readonly repository: CheckpointRepository;
  private readonly normalizer: RowNormalizer;
  private readonly manifests: ManifestBuilder;

  constructor(
    private readonly selection: Selection,
    private readonly rpc: ReadonlyRPC,
    private readonly store: Store,
    private readonly outputs = new OutputManager(),
    private readonly progress: ProgressReporter = silentProgress,
  ) {
    this.repository = new CheckpointRepository(store, selection);
    this.normalizer = new RowNormalizer(selection.network);
    this.manifests = new ManifestBuilder(selection, outputs);
  }

  async run(): Promise<ExtractionManifest> {
    let checkpoint = await this.repository.loadOrCreate();
    const totalBlocks = this.selection.toBlock - this.selection.fromBlock + 1n;
    const percent = (count: bigint) => Number((count * 10000n) / totalBlocks) / 100;
    try {
      const seen = await this.repository.readCommittedRows(checkpoint);
      await recoverRpc(() => this.verifyResumeAnchor(checkpoint), this.selection, this.progress, {
        nextBlock: checkpoint.nextBlock,
        operation: 'resume_anchor',
      });
      await this.publishManifest(checkpoint);
      this.progress({
        phase: 'resume',
        committedBlocks: String(BigInt(checkpoint.nextBlock) - this.selection.fromBlock),
        totalBlocks: String(totalBlocks),
        rows: seen.size,
      });

      while (BigInt(checkpoint.nextBlock) <= this.selection.toBlock) {
        const range = this.repository.nextRange(checkpoint);
        const committedBlocks = range.from - this.selection.fromBlock;
        this.progress({
          phase: 'batch_start',
          fromBlock: String(range.from),
          toBlock: String(range.to),
          percent: percent(committedBlocks),
          committedBlocks: String(committedBlocks),
          totalBlocks: String(totalBlocks),
        });
        const { rows, enricher, batch } = await recoverRpc(
          async () => {
            const rows: Row[] = [];
            const enricher = new Erc20BalanceEnricher(this.selection, this.rpc);
            let scanned = 0;
            let receipts = 0;
            const scanner = new TransactionScanner(
              this.rpc,
              this.selection,
              (blocks, readReceipts) => {
                scanned = blocks;
                receipts = readReceipts;
                this.progress({
                  phase: 'scan',
                  scannedBlocks: String(committedBlocks + BigInt(scanned)),
                  totalBlocks: String(totalBlocks),
                  percent: percent(committedBlocks),
                  scannedPercent: percent(committedBlocks + BigInt(scanned)),
                  receiptsRead: receipts,
                  committedBlocks: String(committedBlocks),
                });
              },
            );
            const batch = await scanner.scan(range.from, range.to, async (match) => {
              rows.push({ ...this.normalizer.normalize(match), ...(await enricher.enrich(match)) });
              this.progress({
                phase: 'enrich',
                processedRows: rows.length,
                receiptsRead: receipts,
                scannedBlocks: String(committedBlocks + BigInt(scanned)),
                totalBlocks: String(totalBlocks),
                committedBlocks: String(committedBlocks),
                percent: percent(committedBlocks),
              });
            });
            return { rows, enricher, batch };
          },
          this.selection,
          this.progress,
          {
            fromBlock: String(range.from),
            toBlock: String(range.to),
            nextBlock: checkpoint.nextBlock,
          },
        );
        for (const row of rows) {
          if (seen.has(rowKey(row))) {
            throw new Error('Transaction identity repeated across committed batches.');
          }
        }
        checkpoint = await this.repository.commitBatch(
          checkpoint,
          range,
          batch.lastBlock.hash,
          rows,
        );
        for (const row of rows) {
          seen.set(rowKey(row), row);
        }
        await this.publishManifest(checkpoint);
        const committed = BigInt(checkpoint.nextBlock) - this.selection.fromBlock;
        this.progress({
          phase: 'batch_committed',
          committedBlocks: String(committed),
          totalBlocks: String(totalBlocks),
          percent: percent(committed),
          rows: seen.size,
          nextBlock: checkpoint.nextBlock,
          failedEnrichments: rows.filter((row) => row.stateEnrichmentStatus === 'failed').length,
          ...enricher.metrics(),
        });
      }

      this.progress({
        phase: 'outputs',
        rows: seen.size,
        formats: this.selection.outputFormats.join(','),
      });
      const result = await this.publishOutputs(checkpoint, [...seen.values()]);
      this.progress({
        phase: 'complete',
        committedBlocks: String(totalBlocks),
        totalBlocks: String(totalBlocks),
        percent: 100,
        rows: seen.size,
      });
      return result;
    } catch (error) {
      this.progress({ phase: 'failed', nextBlock: checkpoint.nextBlock, ...failureDetails(error) });
      await this.reconcile();
      throw error;
    }
  }

  private async verifyResumeAnchor(checkpoint: Checkpoint): Promise<void> {
    const last = checkpoint.parts.at(-1);
    if (!last) {
      return;
    }
    try {
      const block = await this.rpc.getBlock(BigInt(last.toBlock), (candidate) => {
        assertData(candidate.hash.toLowerCase() === last.lastBlockHash);
      });
      assertData(block.hash.toLowerCase() === last.lastBlockHash);
    } catch (error) {
      if (
        error instanceof RpcReadError &&
        error.retryable &&
        error.details.category !== 'invalid_response'
      )
        throw error;
      throw new Error('Resume block hash changed or could not be verified; progress unchanged.');
    }
  }

  private async publishManifest(checkpoint: Checkpoint): Promise<void> {
    await this.store.commit('manifest.json', encodeJson(this.manifests.build(checkpoint)));
  }

  private async publishOutputs(checkpoint: Checkpoint, rows: Row[]): Promise<ExtractionManifest> {
    const manifest = this.manifests.build(checkpoint);
    await this.outputs.write({
      store: this.store,
      checkpoint,
      manifest,
      rows,
      parts: this.repository,
    });
    return manifest;
  }

  private async reconcile(): Promise<void> {
    // A commit can succeed before its caller observes an interruption. Reload
    // durable state instead of guessing which in-memory checkpoint was saved.
    try {
      const checkpoint = await this.repository.load();
      if (checkpoint) {
        const rows = await this.repository.readCommittedRows(checkpoint);
        await this.publishManifest(checkpoint);
        await this.publishOutputs(checkpoint, [...rows.values()]);
      }
    } catch {
      // Preserve the original failure; a subsequent resume retries reconciliation.
    }
  }
}
