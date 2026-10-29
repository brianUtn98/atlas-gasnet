import { expect, it, vi } from 'vitest';
import { parquetReadObjects } from 'hyparquet';
import { ExtractionRunner, SelectionIdentity, type Store } from '../../src/persistence.js';
import { RPCManager } from '../../src/rpc.js';
import { block, fixtureClient, selection } from '../fixtures.js';
import type { OutputFormat } from '../../src/config.js';
class OutputStore implements Store {
  files = new Map<string, Uint8Array>();
  failJson = false;
  async list() {
    return [...this.files.keys()];
  }
  async read(name: string) {
    return this.files.get(name) ?? null;
  }
  async commit(name: string, bytes: Uint8Array) {
    if (this.failJson && name === 'transactions.json') throw new Error('JSON output unavailable');
    this.files.set(name, bytes);
  }
  json(name: string) {
    return JSON.parse(new TextDecoder().decode(this.files.get(name)));
  }
}
const rpc = (client = fixtureClient()) => new RPCManager('ETHEREUM', [client], { retries: 0 });
const combinations: OutputFormat[][] = [
  ['parquet'],
  ['pdf'],
  ['json'],
  ['parquet', 'pdf'],
  ['parquet', 'json'],
  ['pdf', 'json'],
  ['parquet', 'pdf', 'json'],
];
it.each(combinations.map((formats) => ({ formats })))(
  'creates only requested exports: $formats',
  async ({ formats }) => {
    const store = new OutputStore(),
      s = selection({ outputFormats: formats });
    const result = await new ExtractionRunner(s, rpc(), store).run();
    expect(store.files.has('transactions.json')).toBe(formats.includes('json'));
    expect(store.files.has('report.pdf')).toBe(formats.includes('pdf'));
    expect([...store.files.keys()].some((file) => file.endsWith('.parquet'))).toBe(
      formats.includes('parquet'),
    );
    expect(result.outputs).toEqual({
      formats,
      parquetFiles: formats.includes('parquet') ? ['part-9-10.parquet'] : [],
      jsonFile: formats.includes('json') ? 'transactions.json' : null,
      pdfFile: formats.includes('pdf') ? 'report.pdf' : null,
    });
    expect(store.json('manifest.json').complete).toBe(true);
  },
);
it('exports every row, exact decimal strings, nulls and numeric order in JSON', async () => {
  const store = new OutputStore(),
    client = fixtureClient();
  vi.mocked(client.getBlock).mockImplementation(async (height) => {
    const b = block(height);
    b.transactions[0].value = 900719925474099312345n;
    b.transactions[0].nonce = 9007199254740993n;
    return b;
  });
  await new ExtractionRunner(
    selection({ toBlock: '38', batchSize: 7, outputFormats: ['json'] }),
    rpc(client),
    store,
  ).run();
  const rows = store.json('transactions.json');
  expect(rows).toHaveLength(30);
  expect(rows[0]).toMatchObject({
    blockNumber: '9',
    nonce: '9007199254740993',
    value: '900719925474099312345',
    maxFeePerGas: null,
  });
  expect(rows.at(-1).blockNumber).toBe('38');
  expect(new Set(rows.map((r: { transactionHash: string }) => r.transactionHash)).size).toBe(30);
  expect(JSON.stringify(rows)).not.toMatch(/https?:|outputDir|rpcUrl/);
});
it('writes an empty JSON array for zero matches', async () => {
  const store = new OutputStore(),
    client = fixtureClient();
  vi.mocked(client.getBlock).mockImplementation(async (height) => block(height, []));
  await new ExtractionRunner(selection({ outputFormats: ['json'] }), rpc(client), store).run();
  expect(store.json('transactions.json')).toEqual([]);
  expect(store.json('manifest.json')).toMatchObject({ complete: true, rowCount: 0 });
});
it('permits new formats on resume without RPC rescans, duplicates or selection changes', async () => {
  const store = new OutputStore(),
    s = selection({ outputFormats: ['json'], batchSize: 1 });
  await new ExtractionRunner(s, rpc(), store).run();
  const checkpoint = store.files.get('checkpoint.json'),
    client = fixtureClient();
  const withAll = selection();
  expect(new SelectionIdentity(s).fingerprint).toBe(new SelectionIdentity(withAll).fingerprint);
  const result = await new ExtractionRunner(withAll, rpc(client), store).run();
  expect(client.getBlock).toHaveBeenCalledExactlyOnceWith(10n);
  expect(client.getReceipt).not.toHaveBeenCalled();
  expect(store.files.get('checkpoint.json')).toEqual(checkpoint);
  expect(store.files.has('report.pdf')).toBe(true);
  expect(store.json('transactions.json')).toHaveLength(2);
  const rows = [];
  for (const filename of result.outputs.parquetFiles) {
    const bytes = store.files.get(filename)!;
    rows.push(
      ...(await parquetReadObjects({
        file: bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer,
      })),
    );
  }
  expect(rows).toEqual(store.json('transactions.json'));
});
it('resumes old Parquet checkpoints with JSON-only output and leaves existing files untouched', async () => {
  const store = new OutputStore();
  await new ExtractionRunner(selection({ outputFormats: ['parquet'] }), rpc(), store).run();
  const previous = store.files.get('part-9-10.parquet'),
    checkpoint = store.files.get('checkpoint.json');
  await new ExtractionRunner(selection({ outputFormats: ['json'] }), rpc(), store).run();
  expect(store.files.get('part-9-10.parquet')).toEqual(previous);
  expect(store.files.get('checkpoint.json')).toEqual(checkpoint);
  expect(store.json('transactions.json')).toHaveLength(2);
  expect(store.files.has('report.pdf')).toBe(false);
  expect(store.json('manifest.json').outputs.parquetFiles).toEqual([]);
});
it('changes storage for unfinished batches when Parquet is disabled, then exports them later', async () => {
  const store = new OutputStore(),
    client = fixtureClient();
  vi.mocked(client.getBlock).mockImplementation(async (height) => {
    if (height === 10n) throw Error('unavailable');
    return block(height);
  });
  await expect(
    new ExtractionRunner(
      selection({ batchRetries: 0, batchSize: 1, outputFormats: ['parquet'] }),
      rpc(client),
      store,
    ).run(),
  ).rejects.toThrow('exhausted');
  await new ExtractionRunner(
    selection({ batchRetries: 0, outputFormats: ['json'] }),
    rpc(),
    store,
  ).run();
  expect(store.files.has('part-9-9.parquet')).toBe(true);
  expect(store.files.has('part-10-10.parquet')).toBe(false);
  expect(store.files.has('batch-10-10.checkpoint')).toBe(true);
  expect(store.json('transactions.json')).toHaveLength(2);
  await new ExtractionRunner(
    selection({ batchRetries: 0, outputFormats: ['parquet'] }),
    rpc(),
    store,
  ).run();
  expect(store.json('manifest.json').outputs.parquetFiles).toEqual([
    'part-9-9.parquet',
    'part-10-10.parquet',
  ]);
  expect(store.files.has('part-10-10.parquet')).toBe(true);
});
it('keeps committed progress after JSON write failure and regenerates without duplicates', async () => {
  const store = new OutputStore();
  store.failJson = true;
  await expect(
    new ExtractionRunner(selection({ outputFormats: ['json'] }), rpc(), store).run(),
  ).rejects.toThrow('JSON output unavailable');
  const checkpoint = store.files.get('checkpoint.json');
  expect(store.json('checkpoint.json').nextBlock).toBe('11');
  store.failJson = false;
  await new ExtractionRunner(selection({ outputFormats: ['json'] }), rpc(), store).run();
  expect(store.files.get('checkpoint.json')).toEqual(checkpoint);
  expect(store.json('transactions.json')).toHaveLength(2);
});
it('publishes only committed JSON rows on interrupted extraction, then replaces on resume', async () => {
  const store = new OutputStore(),
    client = fixtureClient();
  vi.mocked(client.getBlock).mockImplementation(async (height) => {
    if (height === 10n) throw Error('unavailable');
    return block(height);
  });
  await expect(
    new ExtractionRunner(
      selection({ batchRetries: 0, batchSize: 1, outputFormats: ['json'] }),
      rpc(client),
      store,
    ).run(),
  ).rejects.toThrow('exhausted');
  expect(store.json('transactions.json')).toHaveLength(1);
  expect(store.json('manifest.json').complete).toBe(false);
  await new ExtractionRunner(
    selection({ batchRetries: 0, outputFormats: ['json'] }),
    rpc(),
    store,
  ).run();
  expect(store.json('transactions.json')).toHaveLength(2);
  expect(store.json('manifest.json').complete).toBe(true);
});
