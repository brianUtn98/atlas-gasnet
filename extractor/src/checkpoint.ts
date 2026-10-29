import { parquetReadObjects } from 'hyparquet';
import type { Selection } from './config.js';
import { SelectionIdentity } from './identity.js';
import { orderedRows, ParquetCodec } from './parquet.js';
import { rowKey, schemaVersion, type Row } from './rows.js';
import { decodeJson, digest, encodeJson } from './serialization.js';
import {
  batchFiles,
  type BatchRange,
  type Checkpoint,
  type Part,
  type ExtractionIssue,
} from './state.js';
import type { Store } from './store.js';

/** Repository for durable batches and their checkpoint, independent of presentation. */
export class CheckpointRepository {
  private readonly identity: SelectionIdentity;

  constructor(
    private readonly store: Store,
    private readonly selection: Selection,
    private readonly codec = new ParquetCodec(),
  ) {
    this.identity = new SelectionIdentity(selection);
  }

  async load(): Promise<Checkpoint | null> {
    const bytes = await this.store.read('checkpoint.json');
    if (!bytes) {
      return null;
    }
    const checkpoint = decodeJson(bytes) as Checkpoint;
    this.validate(checkpoint);
    return checkpoint;
  }

  async loadOrCreate(): Promise<Checkpoint> {
    const previous = await this.load();
    if (previous) {
      return previous;
    }
    if ((await this.store.list()).some((name) => !name.endsWith('.tmp'))) {
      throw new Error('Output directory is not an empty run directory.');
    }
    const checkpoint: Checkpoint = {
      version: 1,
      fingerprint: this.identity.fingerprint,
      selection: this.identity.normalized,
      batchSize: this.selection.batchSize,
      nextBlock: String(this.selection.fromBlock),
      parts: [],
    };
    await this.save(checkpoint);
    return checkpoint;
  }

  nextRange(checkpoint: Checkpoint): BatchRange {
    const from = BigInt(checkpoint.nextBlock);
    return { from, to: this.batchEnd(from, checkpoint.batchSize) };
  }

  async readPart(part: Part): Promise<Row[]> {
    const bytes = await this.store.read(part.file);
    if (!bytes || digest(bytes) !== part.sha256) {
      throw new Error('Committed part missing or changed.');
    }
    const rows = part.file.endsWith('.checkpoint')
      ? (decodeJson(bytes) as Row[])
      : ((await parquetReadObjects({
          file: bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ) as ArrayBuffer,
        })) as Row[]);
    if (!Array.isArray(rows) || rows.length !== part.rows) {
      throw new Error('Committed row count mismatch.');
    }
    if (rows.some((row) => row.schemaVersion !== schemaVersion)) {
      throw new Error('Incompatible committed row schema.');
    }
    this.codec.columns(rows);
    return rows;
  }

  async readCommittedRows(checkpoint: Checkpoint): Promise<Map<string, Row>> {
    const seen = new Map<string, Row>();
    for (const part of checkpoint.parts) {
      for (const row of await this.readPart(part)) {
        const key = rowKey(row);
        if (seen.has(key)) {
          throw new Error('Duplicate committed row.');
        }
        seen.set(key, row);
      }
    }
    return seen;
  }

  async commitBatch(
    checkpoint: Checkpoint,
    range: BatchRange,
    lastBlockHash: string | null,
    rows: Row[],
    errors: ExtractionIssue[] = [],
    anchorBlockNumber?: string,
    replacement?: Part,
  ): Promise<Checkpoint> {
    const useParquet = !replacement && this.selection.outputFormats.includes('parquet');
    const sorted = orderedRows(rows);
    this.codec.columns(sorted);
    const encoded = useParquet
      ? this.codec.encode(sorted)
      : { rows: sorted, bytes: encodeJson(sorted) };
    const part: Part = {
      file: replacement
        ? `batch-${range.from}-${range.to}-${digest(encoded.bytes)}.checkpoint`
        : useParquet
          ? batchFiles.parquet(range.from, range.to)
          : batchFiles.state(range.from, range.to),
      fromBlock: String(range.from),
      toBlock: String(range.to),
      lastBlockHash: lastBlockHash?.toLowerCase() ?? null,
      ...(anchorBlockNumber ? { anchorBlockNumber } : {}),
      ...(errors.length ? { errors } : {}),
      rows: encoded.rows.length,
      sha256: digest(encoded.bytes),
    };
    await this.store.commit(part.file, encoded.bytes);
    const next: Checkpoint = {
      ...checkpoint,
      nextBlock: replacement ? checkpoint.nextBlock : String(range.to + 1n),
      parts: replacement
        ? checkpoint.parts.map((previous) => (previous.file === replacement.file ? part : previous))
        : [...checkpoint.parts, part],
    };
    await this.save(next);
    return next;
  }

  private async save(checkpoint: Checkpoint): Promise<void> {
    await this.store.commit('checkpoint.json', encodeJson(checkpoint));
  }

  private batchEnd(from: bigint, size: number): bigint {
    const end = from + BigInt(size) - 1n;
    return end > this.selection.toBlock ? this.selection.toBlock : end;
  }

  private validate(checkpoint: Checkpoint): void {
    if (
      checkpoint.version !== 1 ||
      checkpoint.fingerprint !== this.identity.fingerprint ||
      JSON.stringify(checkpoint.selection) !== JSON.stringify(this.identity.normalized)
    ) {
      throw new Error(
        'Incompatible checkpoint selection or schema; use a separate output directory.',
      );
    }
    if (
      !Number.isSafeInteger(checkpoint.batchSize) ||
      checkpoint.batchSize < 1 ||
      !Array.isArray(checkpoint.parts)
    ) {
      throw new Error('Invalid checkpoint.');
    }
    let next = this.selection.fromBlock;
    for (const part of checkpoint.parts) {
      const end = this.batchEnd(next, checkpoint.batchSize);
      const validFile =
        part.file === batchFiles.state(next, end) ||
        part.file === batchFiles.parquet(next, end) ||
        part.file === `batch-${next}-${end}-${part.sha256}.checkpoint`;
      const errorsValid =
        part.errors === undefined ||
        (Array.isArray(part.errors) &&
          part.errors.every(
            (issue) =>
              issue &&
              ['block', 'receipt'].includes(issue.operation) &&
              /^\d+$/.test(issue.blockNumber) &&
              BigInt(issue.blockNumber) >= next &&
              BigInt(issue.blockNumber) <= end &&
              (issue.operation !== 'receipt' ||
                /^0x[0-9a-fA-F]{64}$/.test(issue.transactionHash ?? '')) &&
              (issue.blockHash === undefined || /^0x[0-9a-fA-F]{64}$/.test(issue.blockHash)) &&
              typeof issue.occurredAt === 'string' &&
              issue.details &&
              typeof issue.details === 'object',
          ));
      const anchor = part.anchorBlockNumber ?? part.toBlock;
      const anchorValid =
        part.lastBlockHash === null
          ? part.errors?.filter((issue) => issue.operation === 'block').length ===
            Number(end - next + 1n)
          : /^0x[0-9a-f]{64}$/.test(part.lastBlockHash) &&
            /^\d+$/.test(anchor) &&
            BigInt(anchor) >= next &&
            BigInt(anchor) <= end;
      if (
        part.fromBlock !== String(next) ||
        part.toBlock !== String(end) ||
        !validFile ||
        !Number.isSafeInteger(part.rows) ||
        part.rows < 0 ||
        !errorsValid ||
        !anchorValid ||
        !/^[0-9a-f]{64}$/.test(part.sha256) ||
        next > this.selection.toBlock
      ) {
        throw new Error('Invalid checkpoint parts.');
      }
      next = end + 1n;
    }
    if (checkpoint.nextBlock !== String(next)) {
      throw new Error('Invalid checkpoint boundary.');
    }
  }
}
