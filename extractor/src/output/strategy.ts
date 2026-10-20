import type { OutputFormat } from '../config.js';
import type { Row } from '../rows.js';
import type { Checkpoint, ExtractionManifest, Part } from '../state.js';
import type { Store } from '../store.js';

export interface PartReader {
  readPart(part: Part): Promise<Row[]>;
}

export interface OutputContext {
  store: Store;
  checkpoint: Checkpoint;
  manifest: ExtractionManifest;
  rows: Row[];
  parts: PartReader;
}

/** A presentation format knows its filenames and how to write its own output. */
export interface OutputStrategy {
  readonly format: OutputFormat;
  filenames(checkpoint: Checkpoint): string[];
  write(context: OutputContext): Promise<void>;
}
