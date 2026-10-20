import { expect, it, vi } from 'vitest';
import { ExtractionRunner, type Store } from '../../src/persistence.js';
import { RPCManager } from '../../src/rpc.js';
import { block, fixtureClient, selection } from '../fixtures.js';
import { pdfText } from '../report-helpers.js';
class ReportStore implements Store {
  files = new Map<string, Uint8Array>();
  failReports = false;
  async list() {
    return [...this.files.keys()];
  }
  async read(name: string) {
    return this.files.get(name) ?? null;
  }
  async commit(name: string, bytes: Uint8Array) {
    if (name === 'report.pdf' && this.failReports) throw new Error('PDF output unavailable');
    this.files.set(name, bytes);
  }
}
const rpc = (client = fixtureClient()) => new RPCManager('ETHEREUM', [client], { retries: 0 });
it('generates and regenerates a report on resume without changing committed data', async () => {
  const store = new ReportStore();
  await new ExtractionRunner(selection(), rpc(), store).run();
  expect(await pdfText(store.files.get('report.pdf')!)).toContain('Transactions: 2');
  const checkpoint = store.files.get('checkpoint.json'),
    part = store.files.get('part-9-10.parquet');
  store.files.delete('report.pdf');
  await new ExtractionRunner(selection(), rpc(), store).run();
  expect(store.files.get('checkpoint.json')).toEqual(checkpoint);
  expect(store.files.get('part-9-10.parquet')).toEqual(part);
  expect(await pdfText(store.files.get('report.pdf')!)).toContain('Status: COMPLETE');
});
it('preserves the checkpoint when PDF output fails and allows report regeneration', async () => {
  const store = new ReportStore();
  store.failReports = true;
  await expect(new ExtractionRunner(selection(), rpc(), store).run()).rejects.toThrow(
    'PDF output unavailable',
  );
  const checkpoint = store.files.get('checkpoint.json');
  expect(JSON.parse(new TextDecoder().decode(checkpoint)).nextBlock).toBe('11');
  store.failReports = false;
  await new ExtractionRunner(selection(), rpc(), store).run();
  expect(store.files.get('checkpoint.json')).toEqual(checkpoint);
  expect(store.files.has('report.pdf')).toBe(true);
});
it('reports only committed rows on an RPC failure and updates the PDF after resume', async () => {
  const store = new ReportStore(),
    client = fixtureClient();
  vi.mocked(client.getBlock).mockImplementation(async (height) => {
    if (height === 10n) throw Error('unavailable');
    return block(height);
  });
  await expect(
    new ExtractionRunner(selection({ batchSize: 1 }), rpc(client), store).run(),
  ).rejects.toThrow('exhausted');
  const incomplete = await pdfText(store.files.get('report.pdf')!);
  expect(incomplete).toContain('INCOMPLETE');
  expect(incomplete).toContain('Transactions: 1');
  await new ExtractionRunner(selection(), rpc(), store).run();
  const complete = await pdfText(store.files.get('report.pdf')!);
  expect(complete).toContain('Status: COMPLETE');
  expect(complete).toContain('Transactions: 2');
});
it('generates a valid report for a zero-match run', async () => {
  const store = new ReportStore(),
    client = fixtureClient();
  vi.mocked(client.getBlock).mockImplementation(async (height) => block(height, []));
  await new ExtractionRunner(selection(), rpc(client), store).run();
  const text = await pdfText(store.files.get('report.pdf')!);
  expect(text).toContain('Status: COMPLETE');
  expect(text).toContain('Showing 0 of 0');
});
