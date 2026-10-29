import { describe, expect, it, vi } from 'vitest';
import { ExtractionRunner, type Store } from '../../src/persistence.js';
import { RPCManager } from '../../src/rpc.js';
import { block, fixtureClient, hash, receipt, selection, tx } from '../fixtures.js';
import { pdfText } from '../report-helpers.js';
import { parquetReadObjects } from 'hyparquet';

class MemoryStore implements Store {
  files = new Map<string, Uint8Array>();
  fault?: (name: string) => void;
  async list() {
    return [...this.files.keys()];
  }
  async read(name: string) {
    return this.files.get(name) ?? null;
  }
  async commit(name: string, bytes: Uint8Array) {
    this.fault?.(name);
    this.files.set(name, bytes);
  }
  json(name: string) {
    return JSON.parse(new TextDecoder().decode(this.files.get(name)));
  }
}
const settings = (patch = {}) =>
  selection({ toBlock: '12', batchSize: 2, batchRetries: 0, ...patch });
const rpc = (client = fixtureClient()) => new RPCManager('ETHEREUM', [client], { retries: 0 });

describe('partial extraction and durable errors', () => {
  it('continues other transactions inside the same block after a receipt failure', async () => {
    const store = new MemoryStore(),
      client = fixtureClient();
    const transactions = [0, 1, 2].map((index) =>
      tx(9n, { hash: hash(900 + index), transactionIndex: index }),
    );
    vi.mocked(client.getBlock).mockResolvedValue(block(9n, transactions));
    vi.mocked(client.getReceipt).mockImplementation(async (h) => {
      if (h === hash(901)) throw new Error('unavailable');
      return receipt(transactions.find((transaction) => transaction.hash === h)!);
    });
    await expect(
      new ExtractionRunner(settings({ toBlock: '9' }), rpc(client), store).run(),
    ).resolves.toMatchObject({ rowCount: 2, errorCount: 1, scanComplete: true });
    expect(client.getReceipt).toHaveBeenCalledTimes(3);
  });
  it('refuses to merge recovery data when a previously observed block hash changed', async () => {
    const store = new MemoryStore(),
      client = fixtureClient();
    vi.mocked(client.getReceipt).mockImplementation(async (h) => {
      if (h === hash(900)) throw new Error('unavailable');
      return receipt(tx(10n));
    });
    const config = settings({ toBlock: '10' });
    await new ExtractionRunner(config, rpc(client), store).run();
    const checkpoint = store.files.get('checkpoint.json');
    const changed = fixtureClient();
    vi.mocked(changed.getBlock).mockImplementation(async (height) =>
      height === 9n
        ? { ...block(height, [tx(height, { blockHash: hash(999) })]), hash: hash(999) }
        : block(height),
    );
    await expect(new ExtractionRunner(config, rpc(changed), store).run()).rejects.toThrow(
      'Previously committed block hash changed',
    );
    expect(store.files.get('checkpoint.json')).toEqual(checkpoint);
  });
  it('keeps processing the same batch and subsequent batches after one receipt fails', async () => {
    const store = new MemoryStore(),
      client = fixtureClient(),
      progress = vi.fn();
    vi.mocked(client.getReceipt).mockImplementation(async (h) => {
      if (h === hash(900)) throw new Error('https://user:secret@private.test');
      return receipt(tx(BigInt(parseInt(h.slice(2), 16) / 100)));
    });
    const result = await new ExtractionRunner(
      settings(),
      rpc(client),
      store,
      undefined,
      progress,
    ).run();
    expect(result).toMatchObject({
      scanComplete: true,
      complete: false,
      rowCount: 3,
      errorCount: 1,
      nextBlock: '13',
    });
    expect(client.getReceipt).toHaveBeenCalledTimes(4);
    expect(store.json('errors.json')).toMatchObject({
      pendingCount: 1,
      errors: [{ operation: 'receipt', blockNumber: '9', transactionHash: hash(900) }],
    });
    expect(JSON.stringify(store.json('errors.json'))).not.toMatch(/secret|private/);
    expect(store.json('transactions.json')).toHaveLength(3);
    expect(await pdfText(store.files.get('report.pdf')!)).toContain('pending extraction errors');
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'complete_with_errors', pendingErrors: 1 }),
    );
  });
  it('repairs only affected batches on rerun and updates JSON and Parquet without duplicates', async () => {
    const store = new MemoryStore(),
      failed = fixtureClient();
    vi.mocked(failed.getReceipt).mockImplementation(async (h) => {
      if (h === hash(900)) throw new Error('unavailable');
      return receipt(tx(BigInt(parseInt(h.slice(2), 16) / 100)));
    });
    await new ExtractionRunner(settings(), rpc(failed), store).run();
    const healthy = fixtureClient();
    const result = await new ExtractionRunner(settings(), rpc(healthy), store).run();
    expect(result).toMatchObject({
      complete: true,
      scanComplete: true,
      errorCount: 0,
      rowCount: 4,
    });
    // Only the last resume anchor and the two blocks in the failed batch are read.
    expect(healthy.getBlock).toHaveBeenCalledTimes(3);
    expect(healthy.getReceipt).toHaveBeenCalledTimes(2);
    expect(store.json('errors.json').pendingCount).toBe(0);
    const rows = store.json('transactions.json');
    expect(new Set(rows.map((r: { transactionHash: string }) => r.transactionHash)).size).toBe(4);
    const bytes = store.files.get('part-9-10.parquet')!;
    expect(
      await parquetReadObjects({
        file: bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer,
      }),
    ).toHaveLength(2);
    await expect(new ExtractionRunner(settings(), rpc(), store).run()).resolves.toMatchObject({
      complete: true,
      rowCount: 4,
    });
  });
  it('records an unavailable final block and preserves an earlier valid resume anchor', async () => {
    const store = new MemoryStore(),
      client = fixtureClient();
    vi.mocked(client.getBlock).mockImplementation(async (h) => {
      if (h === 10n) throw new Error('unavailable');
      return block(h);
    });
    const config = settings({ toBlock: '10' });
    await expect(new ExtractionRunner(config, rpc(client), store).run()).resolves.toMatchObject({
      complete: false,
      rowCount: 1,
      errorCount: 1,
    });
    expect(store.json('checkpoint.json').parts[0]).toMatchObject({
      toBlock: '10',
      anchorBlockNumber: '9',
      lastBlockHash: hash(9),
    });
    await expect(new ExtractionRunner(config, rpc(), store).run()).resolves.toMatchObject({
      complete: true,
      rowCount: 2,
    });
  });
  it('continues even if every block fails, then repairs batches with no prior anchor', async () => {
    const store = new MemoryStore(),
      client = fixtureClient();
    vi.mocked(client.getBlock).mockRejectedValue(new Error('offline'));
    const config = settings({ toBlock: '10' });
    await expect(new ExtractionRunner(config, rpc(client), store).run()).resolves.toMatchObject({
      complete: false,
      rowCount: 0,
      errorCount: 2,
      scanComplete: true,
    });
    expect(store.json('checkpoint.json').parts[0].lastBlockHash).toBeNull();
    await expect(new ExtractionRunner(config, rpc(), store).run()).resolves.toMatchObject({
      complete: true,
      rowCount: 2,
    });
  });
  it('retains earlier good rows when replay encounters a different transient failure', async () => {
    const store = new MemoryStore(),
      client = fixtureClient();
    let failedHash = hash(900);
    vi.mocked(client.getReceipt).mockImplementation(async (h) => {
      if (h === failedHash) throw new Error('unavailable');
      return receipt(tx(BigInt(parseInt(h.slice(2), 16) / 100)));
    });
    const config = settings({ toBlock: '10' });
    await new ExtractionRunner(config, rpc(client), store).run();
    failedHash = hash(1000);
    await expect(new ExtractionRunner(config, rpc(client), store).run()).resolves.toMatchObject({
      complete: true,
      rowCount: 2,
      errorCount: 0,
    });
  });
  it('does not overwrite the durable source if repair checkpoint commit fails', async () => {
    const store = new MemoryStore(),
      client = fixtureClient();
    vi.mocked(client.getReceipt).mockRejectedValue(new Error('offline'));
    const config = settings({ toBlock: '10' });
    await new ExtractionRunner(config, rpc(client), store).run();
    const checkpoint = store.files.get('checkpoint.json'),
      original = store.files.get('part-9-10.parquet');
    store.fault = (name) => {
      if (name === 'checkpoint.json') throw new Error('disk unavailable');
    };
    await expect(new ExtractionRunner(config, rpc(), store).run()).rejects.toThrow(
      'disk unavailable',
    );
    expect(store.files.get('checkpoint.json')).toEqual(checkpoint);
    expect(store.files.get('part-9-10.parquet')).toEqual(original);
    store.fault = undefined;
    await expect(new ExtractionRunner(config, rpc(), store).run()).resolves.toMatchObject({
      complete: true,
      rowCount: 2,
    });
  });
  it('keeps output write errors fatal instead of converting them to missing transactions', async () => {
    const store = new MemoryStore();
    store.fault = (name) => {
      if (name === 'errors.json') throw new Error('disk full');
    };
    await expect(new ExtractionRunner(settings(), rpc(), store).run()).rejects.toThrow('disk full');
  });
});
