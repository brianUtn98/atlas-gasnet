import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { ExtractionManifest } from './state.js';
import { orderedRows } from './parquet.js';
import type { Row } from './rows.js';

export interface GasStatistics {
  count: number;
  total: string;
  min: string | null;
  max: string | null;
  mean: string | null;
  median: string | null;
}
function decimal(numerator: bigint, denominator: bigint): string {
  const hundredths = (numerator * 100n + denominator / 2n) / denominator;
  return `${hundredths / 100n}.${String(hundredths % 100n).padStart(2, '0')}`;
}
export function gasStatistics(rows: Row[]): GasStatistics {
  const values = rows
    .map((row) => BigInt(String(row.gasUsed)))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const total = values.reduce((sum, value) => sum + value, 0n);
  const count = values.length;
  if (!count) return { count, total: '0', min: null, max: null, mean: null, median: null };
  const middle = Math.floor(count / 2);
  return {
    count,
    total: String(total),
    min: String(values[0]),
    max: String(values[count - 1]),
    mean: decimal(total, BigInt(count)),
    median:
      count % 2 ? decimal(values[middle], 1n) : decimal(values[middle - 1] + values[middle], 2n),
  };
}
export function reportSummary(rows: Row[]) {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = `${row.to}/${row.functionSelector ?? 'short calldata'}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return {
    gas: gasStatistics(rows),
    success: rows.filter((r) => r.receiptStatus === 'success').length,
    reverted: rows.filter((r) => r.receiptStatus === 'reverted').length,
    groups: [...groups]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, group]) => ({ key, ...gasStatistics(group) })),
  };
}

// A small paginated layout: wrap long hashes/quantities by measured font width,
// keep related lines together where possible, and reserve space for footers.
class ReportLayout {
  private page!: PDFPage;
  private y = 0;
  private readonly left = 48;
  private readonly width = 499;
  private readonly ink = rgb(0.12, 0.19, 0.27);
  constructor(
    private doc: PDFDocument,
    private regular: PDFFont,
    private bold: PDFFont,
    private mono: PDFFont,
  ) {
    this.newPage();
  }
  private newPage() {
    this.page = this.doc.addPage([595.28, 841.89]);
    this.page.drawRectangle({ x: 0, y: 800, width: 596, height: 42, color: this.ink });
    this.page.drawText('ATLAS GASNET  /  EXTRACTION REPORT', {
      x: this.left,
      y: 816,
      font: this.bold,
      size: 10,
      color: rgb(1, 1, 1),
    });
    this.y = 774;
  }
  private ensure(height: number) {
    if (this.y - height < 55) this.newPage();
  }
  private wrap(text: string, font: PDFFont, size: number): string[] {
    const lines: string[] = [];
    let line = '';
    for (const word of text.split(/\s+/)) {
      if (line && font.widthOfTextAtSize(`${line} ${word}`, size) > this.width) {
        lines.push(line);
        line = '';
      }
      for (const char of word) {
        if (font.widthOfTextAtSize(line + char, size) > this.width) {
          lines.push(line);
          line = '';
        }
        line += char;
      }
      line += ' ';
    }
    if (line.trim()) lines.push(line.trimEnd());
    return lines.length ? lines : [''];
  }
  title(text: string) {
    this.ensure(46);
    this.page.drawText(text, {
      x: this.left,
      y: this.y,
      font: this.bold,
      size: 23,
      color: this.ink,
    });
    this.y -= 35;
  }
  section(text: string) {
    this.ensure(64);
    this.y -= 10;
    this.page.drawText(text, {
      x: this.left,
      y: this.y,
      font: this.bold,
      size: 13,
      color: rgb(0.04, 0.42, 0.45),
    });
    this.y -= 20;
  }
  text(text: string, mono = false) {
    const font = mono ? this.mono : this.regular;
    const size = mono ? 8.5 : 10;
    const leading = mono ? 12 : 14;
    const lines = this.wrap(text, font, size);
    this.ensure(Math.min(lines.length * leading + 5, 650));
    for (const line of lines) {
      this.ensure(leading);
      this.page.drawText(line, { x: this.left, y: this.y, font, size, color: this.ink });
      this.y -= leading;
    }
    this.y -= 4;
  }
  textBlock(lines: string[], mono = false) {
    const font = mono ? this.mono : this.regular;
    const size = mono ? 8.5 : 10;
    const leading = mono ? 12 : 14;
    const height = lines.reduce(
      (sum, text) => sum + this.wrap(text, font, size).length * leading + 4,
      0,
    );
    this.ensure(Math.min(height, 650));
    for (const line of lines) this.text(line, mono);
  }
  finish() {
    const pages = this.doc.getPages();
    pages.forEach((page, index) => {
      page.drawLine({
        start: { x: this.left, y: 42 },
        end: { x: 547, y: 42 },
        thickness: 0.5,
        color: rgb(0.75, 0.8, 0.82),
      });
      page.drawText('Committed observations only | Gas units, not monetary fees', {
        x: this.left,
        y: 28,
        size: 8,
        font: this.regular,
        color: this.ink,
      });
      page.drawText(`${index + 1} / ${pages.length}`, {
        x: 515,
        y: 28,
        size: 8,
        font: this.regular,
        color: this.ink,
      });
    });
  }
}

export interface ReportRenderer {
  render(manifest: ExtractionManifest, rows: Row[]): Promise<Uint8Array>;
}

export class PdfReportRenderer implements ReportRenderer {
  async render(manifest: ExtractionManifest, rows: Row[]): Promise<Uint8Array> {
    const sorted = orderedRows(rows);
    if (sorted.length !== manifest.rowCount)
      throw new Error('PDF row count does not match committed manifest.');
    const summary = reportSummary(sorted);
    const doc = await PDFDocument.create({ updateMetadata: false });
    doc.setTitle('Atlas GasNet - Extraction report');
    doc.setAuthor('Atlas GasNet');
    doc.setCreator('Atlas GasNet extractor');
    doc.setLanguage('en');
    const regular = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const mono = await doc.embedFont(StandardFonts.Courier);
    const layout = new ReportLayout(doc, regular, bold, mono);
    this.renderOverview(layout, manifest);
    layout.text(
      `ERC-20 state enrichment: ${manifest.stateEnrichment.enabled ? 'enabled' : 'disabled'}; policy: ${manifest.stateEnrichment.failurePolicy}.`,
    );
    layout.text(
      ['complete', 'failed', 'not_applicable']
        .map(
          (status) =>
            `${status}: ${sorted.filter((row) => row.stateEnrichmentStatus === status).length}`,
        )
        .join(' | '),
    );
    layout.text(manifest.stateEnrichment.limitation);
    layout.text(
      `Amount/balance ratio encoding: ${manifest.stateEnrichment.ratioEncoding}; zero denominator: ${manifest.stateEnrichment.ratioZeroDenominator}.`,
    );
    this.renderStatistics(layout, summary);
    this.renderSelection(layout, manifest);
    this.renderGroups(layout, summary);
    this.renderDictionary(layout, manifest);
    this.renderSample(layout, sorted);
    layout.finish();
    return doc.save({ useObjectStreams: false });
  }

  private renderOverview(layout: ReportLayout, manifest: ExtractionManifest): void {
    layout.title('Historical transaction dataset');
    layout.text(
      `Status: ${manifest.complete ? 'COMPLETE' : manifest.scanComplete ? 'INCOMPLETE - pending extraction errors' : 'INCOMPLETE - unfinished blocks remain'}`,
    );
    layout.text(
      `Network: ${manifest.selection.network} | Schema: ${manifest.schemaVersion} | Transactions: ${manifest.rowCount} | Parts: ${manifest.parts.length}`,
    );
    layout.text(
      `Requested blocks: ${manifest.selection.fromBlock} through ${manifest.selection.toBlock} (inclusive)`,
    );
    layout.text(
      `Last committed block: ${manifest.lastCommittedBlock ?? 'none'} | Next block: ${manifest.nextBlock}`,
    );
    layout.text(`Selection fingerprint: ${manifest.fingerprint}`, true);
  }

  private renderStatistics(layout: ReportLayout, summary: ReturnType<typeof reportSummary>): void {
    layout.section('1. Gas consumed and execution outcomes');
    layout.text(`Successful: ${summary.success} | Reverted: ${summary.reverted}`);
    if (!summary.gas.count)
      layout.text(
        'No matching transactions in committed blocks. Gas statistics are not available; no zero-gas observations were invented.',
      );
    else {
      layout.text(
        `Total gasUsed: ${summary.gas.total} | Minimum: ${summary.gas.min} | Maximum: ${summary.gas.max}`,
      );
      layout.text(
        `Mean gasUsed: ${summary.gas.mean} | Median gasUsed: ${summary.gas.median} (rounded to 2 decimals)`,
      );
    }
  }

  private renderSelection(layout: ReportLayout, manifest: ExtractionManifest): void {
    layout.section('2. Selection and coverage');
    for (const contract of manifest.selection.contracts) {
      layout.textBlock(
        [
          `Recipient: ${contract.address}`,
          `Functions (selectors, OR): ${contract.functions?.join(', ') ?? 'unrestricted'}`,
          `Event topic0 (OR): ${contract.eventTopics?.join(', ') ?? 'unrestricted'}`,
        ],
        true,
      );
    }
    layout.text(
      'Only direct top-level calls are selected; internal calls and router-mediated interactions are outside scope. Function and event filters combine with AND.',
    );
    if (manifest.eventSelectionBias) layout.text(manifest.eventSelectionBias);
  }

  private renderGroups(layout: ReportLayout, summary: ReturnType<typeof reportSummary>): void {
    layout.section('3. Gas by recipient and function selector');
    if (!summary.groups.length) layout.text('No observations to group.');
    for (const group of summary.groups) {
      layout.text(group.key, true);
      layout.text(
        `Transactions: ${group.count} | Mean: ${group.mean} | Median: ${group.median} | Min: ${group.min} | Max: ${group.max}`,
      );
    }
  }

  private renderDictionary(layout: ReportLayout, manifest: ExtractionManifest): void {
    layout.section('4. How to interpret the dataset');
    layout.text(
      'gasUsed is the observed prediction target from the receipt. gasLimit is the submitted execution cap, not gas consumed. value is native currency in base units, not an ERC-20 token amount.',
    );
    layout.text(`Initial candidate predictors: ${manifest.initialPredictors.join(', ')}.`);
    layout.text(
      'BeforeBlock balances refer to the end of the previous block, recorded in stateBlockNumber. Equality with amount does not guarantee that a transfer emptied the sender. Missing balances and indicators are null, never assumed zero. gasUsed remains receipt-observed.',
    );
    layout.text(
      'tokenAmount, isZeroAmount and isSelfTransfer come from submitted calldata and persist when state reads fail. senderHasEnoughBalance compares the reference balance to amount; it does not guarantee execution success. A zero sender balance gives a null ratio, including 0/0.',
    );
    layout.text(
      'Encode network, recipient and function selector categorically. Calldata counts describe submitted bytes; access-list counts describe declared keys, not actual storage accesses.',
    );
    layout.text(
      'Receipt status, transaction/block hashes, inclusion block/time and ordering are audit fields, not pre-execution predictors. These statistics describe this selected sample and do not establish model performance.',
    );
  }

  private renderSample(layout: ReportLayout, sorted: Row[]): void {
    layout.section('5. Transaction sample (first 20 in numeric block order)');
    layout.text(
      `Showing ${Math.min(sorted.length, 20)} of ${sorted.length} committed transactions. Read Parquet for the complete dataset and exact quantities.`,
    );
    for (const row of sorted.slice(0, 20)) {
      layout.textBlock(
        [
          `Block ${row.blockNumber} | Index ${row.transactionIndex} | ${row.receiptStatus} | gasUsed ${row.gasUsed}`,
          `Transaction: ${row.transactionHash}`,
          `To: ${row.to} | Selector: ${row.functionSelector ?? 'none'}`,
          `gasLimit: ${row.gasLimit} | value (native base units): ${row.value}`,
        ],
        true,
      );
    }
  }
}
