import type { Selection } from './config.js';
import { statePolicy } from './enrichment.js';
import { SelectionIdentity } from './identity.js';
import { OutputManager } from './output/manager.js';
import { physicalSchema } from './parquet.js';
import { audit, features, initialPredictors, schemaVersion, targets } from './rows.js';
import type { Checkpoint, ExtractionManifest } from './state.js';

export class ManifestBuilder {
  constructor(
    private readonly selection: Selection,
    private readonly outputs: OutputManager,
    private readonly identity = new SelectionIdentity(selection),
  ) {}

  build(checkpoint: Checkpoint): ExtractionManifest {
    const last = [...checkpoint.parts].reverse().find((part) => part.lastBlockHash !== null);
    const errorCount = checkpoint.parts.reduce((sum, part) => sum + (part.errors?.length ?? 0), 0);
    const scanComplete = BigInt(checkpoint.nextBlock) > this.selection.toBlock;
    return {
      stateEnrichment: { enabled: this.selection.erc20BalanceEnrichment, ...statePolicy },
      schemaVersion,
      selection: this.identity.normalized,
      fingerprint: checkpoint.fingerprint,
      features,
      initialPredictors,
      targets,
      audit,
      physicalSchema,
      outputs: this.outputs.describe(this.selection.outputFormats, checkpoint),
      parts: checkpoint.parts,
      rowCount: checkpoint.parts.reduce((sum, part) => sum + part.rows, 0),
      nextBlock: checkpoint.nextBlock,
      lastCommittedBlock: last?.lastBlockHash ? (last.anchorBlockNumber ?? last.toBlock) : null,
      lastCommittedBlockHash: last?.lastBlockHash ?? null,
      complete: scanComplete && errorCount === 0,
      scanComplete,
      errorCount,
      errorsFile: 'errors.json',
      eventSelectionBias: this.selection.contracts.some((contract) => contract.eventTopics)
        ? 'Topic filters select on execution outcomes and exclude reverted calls without persisted matching logs.'
        : null,
    };
  }
}
