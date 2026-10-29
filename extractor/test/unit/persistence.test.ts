import { describe, expect, it, vi } from 'vitest';
import { ExtractionRunner, SelectionIdentity, type Store } from '../../src/persistence.js';
import { RPCManager, InvalidData } from '../../src/rpc.js';
import { features, initialPredictors } from '../../src/rows.js';
import { address, other, hash, selection, fixtureClient, block } from '../fixtures.js';
export class MemoryStore implements Store {
  files = new Map<string, Uint8Array>();
  fault?: (name: string, bytes: Uint8Array, stage: 'before' | 'after') => void;
  async list() {
    return [...this.files.keys()];
  }
  async read(name: string) {
    return this.files.get(name) ?? null;
  }
  async commit(name: string, bytes: Uint8Array) {
    this.fault?.(name, bytes, 'before');
    this.files.set(name, bytes);
    this.fault?.(name, bytes, 'after');
  }
  json(name: string) {
    return JSON.parse(new TextDecoder().decode(this.files.get(name)));
  }
}
const rpc = (c = fixtureClient()) => new RPCManager('ETHEREUM', [c], { retries: 0 });
describe('durable run state', () => {
  it('replays only the failed batch after an invalid receipt without duplicate rows', async () => {
    const store = new MemoryStore(),
      client = fixtureClient();
    let failed = false;
    vi.mocked(client.getReceipt).mockImplementation(async (hash) => {
      if (hash.endsWith('3e8') && !failed) {
        failed = true;
        throw new InvalidData('receipt_identity');
      }
      const height = BigInt(parseInt(hash.slice(2), 16) / 100);
      return {
        transactionHash: hash,
        blockHash: block(height).hash,
        blockNumber: height,
        transactionIndex: 0,
        from: other,
        to: address,
        gasUsed: 25000n,
        status: 'success',
        logs: [],
      };
    });
    const progress = vi.fn();
    const result = await new ExtractionRunner(
      selection({
        batchSize: 1,
        batchRetryDelayMs: 1,
        continueOnError: false,
        outputFormats: ['json', 'parquet'],
      }),
      rpc(client),
      store,
      undefined,
      progress,
    ).run();
    expect(result).toMatchObject({ complete: true, rowCount: 2, nextBlock: '11' });
    expect(result.parts).toHaveLength(2);
    expect(store.json('transactions.json')).toHaveLength(2);
    expect(client.getReceipt).toHaveBeenCalledTimes(3);
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'batch_retry',
        nextBlock: '10',
        reason: 'receipt_identity',
      }),
    );
  });
  it.each(['before', 'after'] as const)(
    'replays a part after failure %s part commit without duplicates',
    async (stage) => {
      const store = new MemoryStore();
      let once = true;
      store.fault = (name, _, when) => {
        if (once && name.endsWith('.parquet') && when === stage) {
          once = false;
          throw Error('interruption');
        }
      };
      await expect(
        new ExtractionRunner(selection({ batchSize: 1 }), rpc(), store).run(),
      ).rejects.toThrow('interruption');
      expect(store.json('checkpoint.json').nextBlock).toBe('9');
      expect(store.json('manifest.json').rowCount).toBe(0);
      const result = await new ExtractionRunner(selection({ batchSize: 100 }), rpc(), store).run();
      expect(result).toMatchObject({ complete: true, rowCount: 2 });
      expect(result.parts.map((p) => p.file)).toEqual(['part-9-9.parquet', 'part-10-10.parquet']);
      expect(store.json('checkpoint.json').batchSize).toBe(1);
      expect((await store.list()).filter((n) => n.endsWith('.parquet'))).toHaveLength(2);
    },
  );
  it.each(['before', 'after'] as const)('recovers %s checkpoint commit', async (stage) => {
    const store = new MemoryStore();
    let once = true;
    store.fault = (name, bytes, when) => {
      if (
        once &&
        name === 'checkpoint.json' &&
        when === stage &&
        JSON.parse(new TextDecoder().decode(bytes)).parts.length === 1
      ) {
        once = false;
        throw Error('interruption');
      }
    };
    await expect(
      new ExtractionRunner(selection({ batchSize: 1 }), rpc(), store).run(),
    ).rejects.toThrow('interruption');
    expect(store.json('manifest.json').rowCount).toBe(stage === 'after' ? 1 : 0);
    const result = await new ExtractionRunner(selection(), rpc(), store).run();
    expect(result.rowCount).toBe(2);
    expect(result.complete).toBe(true);
    expect((await new ExtractionRunner(selection(), rpc(), store).run()).rowCount).toBe(2);
  });
  it('normalizes selections independently of order, duplicates, output and operational options', () => {
    const a = selection({
      contracts: [
        {
          address,
          functions: ['transfer(address,uint256)', '0xa9059cbb'],
          eventTopics: [hash(2), hash(1)],
        },
        { address: other },
      ],
      batchSize: 1,
    });
    const b = selection({
      contracts: [
        { address: other },
        { address, functions: ['0xa9059cbb'], eventTopics: [hash(1), hash(2)] },
      ],
      batchSize: 99,
      outputDir: 'another',
      retries: 0,
    });
    expect(new SelectionIdentity(a).fingerprint).toBe(new SelectionIdentity(b).fingerprint);
  });
  it.each([
    { network: 'POLYGON' },
    { fromBlock: '8' },
    { toBlock: '11' },
    { contracts: [{ address: other }] },
    { contracts: [{ address, functions: ['0xa9059cbb'] }] },
    { contracts: [{ address, eventTopics: [hash(1)] }] },
  ])('rejects changed selection %j', async (patch) => {
    const store = new MemoryStore();
    await new ExtractionRunner(selection(), rpc(), store).run();
    await expect(new ExtractionRunner(selection(patch), rpc(), store).run()).rejects.toThrow(
      'Incompatible',
    );
  });
  it('rejects changed schema and corrupted boundaries or part bytes', async () => {
    const store = new MemoryStore();
    await new ExtractionRunner(selection(), rpc(), store).run();
    const original = store.files.get('checkpoint.json')!;
    const cp = store.json('checkpoint.json');
    cp.selection.schemaVersion = '1';
    await store.commit('checkpoint.json', new TextEncoder().encode(JSON.stringify(cp)));
    await expect(new ExtractionRunner(selection(), rpc(), store).run()).rejects.toThrow(
      'Incompatible',
    );
    store.files.set('checkpoint.json', original);
    const p = store.json('checkpoint.json');
    p.nextBlock = '999';
    store.files.set('checkpoint.json', new TextEncoder().encode(JSON.stringify(p)));
    await expect(new ExtractionRunner(selection(), rpc(), store).run()).rejects.toThrow('boundary');
    store.files.set('checkpoint.json', original);
    store.files.set('part-9-10.parquet', new Uint8Array([1]));
    await expect(new ExtractionRunner(selection(), rpc(), store).run()).rejects.toThrow(
      'missing or changed',
    );
  });
  it('permits endpoint changes but stops at a changed resume anchor', async () => {
    const store = new MemoryStore();
    await new ExtractionRunner(selection(), rpc(), store).run();
    const saved = store.files.get('checkpoint.json');
    expect(
      (await new ExtractionRunner(selection(), rpc(fixtureClient()), store).run()).complete,
    ).toBe(true);
    const changed = fixtureClient();
    vi.mocked(changed.getBlock).mockImplementation(async (h) => ({ ...block(h), hash: hash(999) }));
    await expect(new ExtractionRunner(selection(), rpc(changed), store).run()).rejects.toThrow(
      'Resume block hash',
    );
    expect(store.files.get('checkpoint.json')).toEqual(saved);
  });
  it('does not skip unresolved work after RPC exhaustion and reconciles incomplete counts', async () => {
    const store = new MemoryStore(),
      client = fixtureClient();
    vi.mocked(client.getBlock).mockImplementation(async (h) => {
      if (h === 10n) throw Error('https://user:private@secret.test/token');
      return block(h);
    });
    await expect(
      new ExtractionRunner(
        selection({ continueOnError: false, batchRetries: 0, batchSize: 1 }),
        rpc(client),
        store,
      ).run(),
    ).rejects.toThrow('exhausted');
    expect(store.json('checkpoint.json').nextBlock).toBe('10');
    expect(store.json('manifest.json')).toMatchObject({
      complete: false,
      rowCount: 1,
      nextBlock: '10',
    });
    expect(JSON.stringify(store.json('manifest.json'))).not.toMatch(/https:|private|secret/);
    const saved = store.files.get('checkpoint.json');
    await expect(
      new ExtractionRunner(
        selection({ continueOnError: false, batchRetries: 0 }),
        rpc(client),
        store,
      ).run(),
    ).rejects.toThrow();
    expect(store.files.get('checkpoint.json')).toEqual(saved);
    expect(
      (
        await new ExtractionRunner(
          selection({ continueOnError: false, batchRetries: 0 }),
          rpc(),
          store,
        ).run()
      ).rowCount,
    ).toBe(2);
  });
  it('advances empty batches and includes all roles without endpoint metadata', async () => {
    const c = fixtureClient();
    vi.mocked(c.getBlock).mockImplementation(async (h) => block(h, []));
    const result = await new ExtractionRunner(
      selection({ batchSize: 1 }),
      rpc(c),
      new MemoryStore(),
    ).run();
    expect(result).toMatchObject({
      complete: true,
      rowCount: 0,
      nextBlock: '11',
      features,
      initialPredictors,
    });
    expect(result.parts).toHaveLength(2);
    expect(result.parts.every((p) => p.rows === 0)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('http');
  });
  it('rejects reused output without a checkpoint and duplicate identities across blocks', async () => {
    const store = new MemoryStore();
    store.files.set('manifest.json', new Uint8Array());
    await expect(new ExtractionRunner(selection(), rpc(), store).run()).rejects.toThrow(
      'empty run',
    );
    const c = fixtureClient();
    let current = 9n;
    vi.mocked(c.getBlock).mockImplementation(async (h) => {
      current = h;
      const b = block(h);
      b.transactions[0].hash = hash(900);
      return b;
    });
    vi.mocked(c.getReceipt).mockImplementation(async () => ({
      transactionHash: hash(900),
      blockHash: hash(Number(current)),
      blockNumber: current,
      transactionIndex: 0,
      from: other,
      to: address,
      gasUsed: 1n,
      status: 'success',
      logs: [],
    }));
    const duplicateStore = new MemoryStore();
    await expect(
      new ExtractionRunner(selection({ batchSize: 1 }), rpc(c), duplicateStore).run(),
    ).rejects.toThrow('repeated across');
    expect(duplicateStore.json('checkpoint.json').nextBlock).toBe('10');
  });
});
