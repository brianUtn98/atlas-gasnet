import { CheckpointRepository } from './checkpoint.js';
import type { Selection } from './config.js';
import { TransactionScanner } from './extract.js';
import { ManifestBuilder } from './manifest.js';
import { OutputManager } from './output/manager.js';
import { RowNormalizer, rowKey, type Row } from './rows.js';
import { assertData, type ReadonlyRPC } from './rpc.js';
import { encodeJson } from './serialization.js';
import type { Checkpoint, ExtractionManifest } from './state.js';
import type { Store } from './store.js';

export { SelectionIdentity } from './identity.js';
export { FileStore } from './store.js';
export type { Store } from './store.js';
export type { Checkpoint, ExtractionManifest, Part } from './state.js';

/** Application service: coordinate extraction, durable progress and output strategies. */
export class ExtractionRunner {
  private readonly repository: CheckpointRepository;
  private readonly scanner: TransactionScanner;
  private readonly normalizer: RowNormalizer;
  private readonly manifests: ManifestBuilder;

  constructor(
    private readonly selection: Selection,
    private readonly rpc: ReadonlyRPC,
    private readonly store: Store,
    private readonly outputs = new OutputManager(),
  ) {
    this.repository = new CheckpointRepository(store, selection);
    this.scanner = new TransactionScanner(rpc, selection);
    this.normalizer = new RowNormalizer(selection.network);
    this.manifests = new ManifestBuilder(selection, outputs);
  }

  async run(): Promise<ExtractionManifest> {
    let checkpoint = await this.repository.loadOrCreate();
    try {
      const seen = await this.repository.readCommittedRows(checkpoint);
      await this.verifyResumeAnchor(checkpoint);
      await this.publishManifest(checkpoint);

      while (BigInt(checkpoint.nextBlock) <= this.selection.toBlock) {
        const range = this.repository.nextRange(checkpoint);
        const batch = await this.scanner.scan(range.from, range.to);
        const rows = batch.matches.map((match) => this.normalizer.normalize(match));
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
      }

      return await this.publishOutputs(checkpoint, [...seen.values()]);
    } catch (error) {
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
    } catch {
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
