import type { ContractSelection, NetworkName, OutputFormat } from './config.js';
import type { physicalSchema } from './parquet.js';
import type { audit, features, initialPredictors, targets } from './rows.js';

export interface NormalizedSelection {
  version: number;
  schemaVersion: string;
  network: NetworkName;
  fromBlock: string;
  toBlock: string;
  contracts: ContractSelection[];
}

export interface Part {
  file: string;
  fromBlock: string;
  toBlock: string;
  lastBlockHash: string;
  rows: number;
  sha256: string;
}

export interface Checkpoint {
  version: 1;
  fingerprint: string;
  selection: NormalizedSelection;
  batchSize: number;
  nextBlock: string;
  parts: Part[];
}

export interface OutputDescription {
  formats: OutputFormat[];
  parquetFiles: string[];
  jsonFile: string | null;
  pdfFile: string | null;
}

export interface ExtractionManifest {
  schemaVersion: string;
  selection: NormalizedSelection;
  fingerprint: string;
  features: typeof features;
  initialPredictors: typeof initialPredictors;
  targets: typeof targets;
  audit: typeof audit;
  physicalSchema: typeof physicalSchema;
  outputs: OutputDescription;
  parts: Part[];
  rowCount: number;
  nextBlock: string;
  lastCommittedBlock: string | null;
  lastCommittedBlockHash: string | null;
  complete: boolean;
  eventSelectionBias: string | null;
}

export interface BatchRange {
  from: bigint;
  to: bigint;
}

export const batchFiles = {
  parquet: (from: bigint, to: bigint): string => `part-${from}-${to}.parquet`,
  state: (from: bigint, to: bigint): string => `batch-${from}-${to}.checkpoint`,
};
