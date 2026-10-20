import type { OutputFormat } from '../config.js';
import { orderedRows } from '../parquet.js';
import type { Checkpoint, OutputDescription } from '../state.js';
import { JsonOutputStrategy } from './json.js';
import { ParquetOutputStrategy } from './parquet.js';
import { PdfOutputStrategy } from './pdf.js';
import type { OutputContext, OutputStrategy } from './strategy.js';

/** Strategy registry; the runner never needs format-specific write branches. */
export class OutputManager {
  private readonly byFormat: Map<OutputFormat, OutputStrategy>;

  constructor(
    private readonly strategies: readonly OutputStrategy[] = [
      new ParquetOutputStrategy(),
      new JsonOutputStrategy(),
      new PdfOutputStrategy(),
    ],
  ) {
    this.byFormat = new Map(strategies.map((strategy) => [strategy.format, strategy]));
    if (this.byFormat.size !== strategies.length) {
      throw new Error('Duplicate output strategy.');
    }
  }

  describe(formats: OutputFormat[], checkpoint: Checkpoint): OutputDescription {
    const files = new Map(
      this.selected(formats).map((strategy) => [strategy.format, strategy.filenames(checkpoint)]),
    );
    return {
      formats: [...formats],
      parquetFiles: files.get('parquet') ?? [],
      jsonFile: files.get('json')?.[0] ?? null,
      pdfFile: files.get('pdf')?.[0] ?? null,
    };
  }

  async write(context: OutputContext): Promise<void> {
    const selected = this.selected(context.manifest.outputs.formats);
    const orderedContext = { ...context, rows: orderedRows(context.rows) };
    for (const strategy of selected) {
      await strategy.write(orderedContext);
    }
  }

  private selected(formats: OutputFormat[]): OutputStrategy[] {
    for (const format of formats) {
      if (!this.byFormat.has(format)) {
        throw new Error(`No output strategy registered for ${format}.`);
      }
    }
    return this.strategies.filter((strategy) => formats.includes(strategy.format));
  }
}
