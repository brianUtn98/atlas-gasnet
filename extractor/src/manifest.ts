import type { Selection } from './config.js';
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
    const last = checkpoint.parts.at(-1);
    return {
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
      lastCommittedBlock: last?.toBlock ?? null,
      lastCommittedBlockHash: last?.lastBlockHash ?? null,
      complete: BigInt(checkpoint.nextBlock) > this.selection.toBlock,
      eventSelectionBias: this.selection.contracts.some((contract) => contract.eventTopics)
        ? 'Topic filters select on execution outcomes and exclude reverted calls without persisted matching logs.'
        : null,
    };
  }
}
