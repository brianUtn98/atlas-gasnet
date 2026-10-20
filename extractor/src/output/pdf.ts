import { PdfReportRenderer, type ReportRenderer } from '../report.js';
import type { OutputContext, OutputStrategy } from './strategy.js';

export class PdfOutputStrategy implements OutputStrategy {
  readonly format = 'pdf';

  constructor(private readonly renderer: ReportRenderer = new PdfReportRenderer()) {}

  filenames(): string[] {
    return ['report.pdf'];
  }

  async write(context: OutputContext): Promise<void> {
    const bytes = await this.renderer.render(context.manifest, context.rows);
    await context.store.commit('report.pdf', bytes);
  }
}
