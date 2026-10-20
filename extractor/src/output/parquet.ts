import { ParquetCodec } from '../parquet.js';
import { batchFiles, type Checkpoint } from '../state.js';
import type { OutputContext, OutputStrategy } from './strategy.js';

export class ParquetOutputStrategy implements OutputStrategy {
  readonly format = 'parquet';

  constructor(private readonly codec = new ParquetCodec()) {}

  filenames(checkpoint: Checkpoint): string[] {
    return checkpoint.parts.map((part) =>
      batchFiles.parquet(BigInt(part.fromBlock), BigInt(part.toBlock)),
    );
  }

  async write(context: OutputContext): Promise<void> {
    for (const part of context.checkpoint.parts) {
      const filename = batchFiles.parquet(BigInt(part.fromBlock), BigInt(part.toBlock));
      if (part.file === filename) {
        continue;
      }
      const rows = await context.parts.readPart(part);
      await context.store.commit(filename, this.codec.encode(rows).bytes);
    }
  }
}
