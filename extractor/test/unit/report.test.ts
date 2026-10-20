import { expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { gasStatistics, PdfReportRenderer, reportSummary } from '../../src/report.js';
import { RowNormalizer } from '../../src/rows.js';
import { block, receipt, tx, hash, address } from '../fixtures.js';
import { pdfText, reportManifest } from '../report-helpers.js';
const row = (gas = 25000n, patch = {}) => {
  const t = tx();
  return {
    ...new RowNormalizer('ETHEREUM').normalize({
      transaction: t,
      block: block(),
      receipt: receipt(t, { gasUsed: gas }),
    }),
    ...patch,
  };
};
it('calculates exact gas statistics without float conversion, including odd/even medians', () => {
  const n = 9007199254740993n;
  expect(gasStatistics([row(n), row(n + 1n)])).toEqual({
    count: 2,
    total: '18014398509481987',
    min: String(n),
    max: String(n + 1n),
    mean: '9007199254740993.50',
    median: '9007199254740993.50',
  });
  expect(gasStatistics([row(4n), row(1n), row(2n)])).toMatchObject({
    mean: '2.33',
    median: '2.00',
  });
  expect(gasStatistics([row(0n)])).toMatchObject({ min: '0', max: '0', mean: '0.00' });
  expect(gasStatistics([])).toEqual({
    count: 0,
    total: '0',
    min: null,
    max: null,
    mean: null,
    median: null,
  });
});
it('groups by recipient and selector and counts execution outcomes', () => {
  const result = reportSummary([
    row(),
    row(50000n, { receiptStatus: 'reverted' }),
    row(1n, { functionSelector: null }),
  ]);
  expect(result).toMatchObject({ success: 2, reverted: 1 });
  expect(result.groups.find((g) => g.key === `${address}/0xa9059cbb`)).toMatchObject({
    count: 2,
    mean: '37500.00',
  });
  expect(result.groups.find((g) => g.key.endsWith('/short calldata'))?.count).toBe(1);
});
it('creates a readable report with roles, exact quantities, outcomes and no endpoint metadata', async () => {
  const rows = [row(9007199254740993n, { receiptStatus: 'reverted' })];
  const manifest = { ...reportManifest(rows), rpcUrl: 'https://user:password@private.test/token' };
  const bytes = await new PdfReportRenderer().render(manifest, rows),
    text = await pdfText(bytes);
  expect(Buffer.from(bytes).subarray(0, 5).toString()).toBe('%PDF-');
  expect(text).toContain('Status: COMPLETE');
  expect(text).toContain('9007199254740993');
  expect(text).toContain('Reverted: 1');
  expect(text).toContain('gasLimit');
  expect(text).toContain('not an ERC-20 token amount');
  expect(text).toContain('audit fields, not pre-execution predictors');
  expect(text).not.toMatch(/password|private\.test|rpcUrl/);
});
it('distinguishes incomplete and empty reports without inventing gas observations', async () => {
  const text = await pdfText(await new PdfReportRenderer().render(reportManifest([], false), []));
  expect(text).toContain('INCOMPLETE');
  expect(text).toContain('No matching transactions');
  expect(text).toContain('No observations to group');
  expect(text).toContain('Showing 0 of 0');
  expect(text).not.toContain('Mean gasUsed: 0');
});
it('paginates long selections and limits the sample to the first 20 in numeric order', async () => {
  const rows = Array.from({ length: 30 }, (_, i) =>
    row(25000n, {
      transactionHash: hash(1000 + i),
      blockNumber: String(i + 1),
      transactionIndex: '0',
    }),
  ).reverse();
  const manifest = reportManifest(rows);
  manifest.selection.contracts = Array.from({ length: 35 }, (_, i) => ({
    address: '0x' + i.toString(16).padStart(40, '0'),
    functions: ['0xa9059cbb'],
    eventTopics: [hash(1), hash(2), hash(3)],
  }));
  manifest.eventSelectionBias = 'Topic filters select on execution outcomes.';
  const bytes = await new PdfReportRenderer().render(manifest, rows),
    text = await pdfText(bytes);
  expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThan(2);
  expect(text).toContain('Topic filters select on execution outcomes');
  expect(text).toContain('Showing 20 of 30');
  expect(text).toContain(hash(1019));
  expect(text).not.toContain(hash(1020));
  expect(text).toContain('Block 1 | Index 0');
});
it('rejects a manifest/committed-row mismatch', async () => {
  await expect(new PdfReportRenderer().render(reportManifest([row()]), [])).rejects.toThrow(
    'row count',
  );
});
