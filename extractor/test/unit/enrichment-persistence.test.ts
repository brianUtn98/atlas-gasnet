import { expect, it, vi } from 'vitest';
import { parquetReadObjects } from 'hyparquet';
import { ExtractionRunner, SelectionIdentity, type Store } from '../../src/persistence.js';
import { CheckpointRepository } from '../../src/checkpoint.js';
import { RPCManager } from '../../src/rpc.js';
import { audit, features, RowNormalizer } from '../../src/rows.js';
import { digest, encodeJson } from '../../src/serialization.js';
import { address, other, block, fixtureClient, receipt, selection, tx } from '../fixtures.js';
import { pdfText } from '../report-helpers.js';

class MemoryStore implements Store {
  files = new Map<string, Uint8Array>();
  async list() {
    return [...this.files.keys()];
  }
  async read(name: string) {
    return this.files.get(name) ?? null;
  }
  async commit(name: string, bytes: Uint8Array) {
    this.files.set(name, bytes);
  }
  json(name: string) {
    return JSON.parse(new TextDecoder().decode(this.files.get(name)));
  }
}
const huge = (1n << 200n) + 1n;
const data = `0xa9059cbb${other.slice(2).padStart(64, '0')}${huge.toString(16).padStart(64, '0')}`;
const enriched = (patch = {}) =>
  selection({
    erc20BalanceEnrichment: true,
    contracts: [{ address, erc20: true }],
    ...patch,
  });
function setup(fail = false) {
  const client = fixtureClient();
  vi.mocked(client.getBlock).mockImplementation(async (height) =>
    block(height, [tx(height, { input: data })]),
  );
  vi.mocked(client.getTokenBalance).mockImplementation(async () => {
    if (fail) throw Error('https://secret@private.test/token');
    return huge;
  });
  return { client, rpc: new RPCManager('ETHEREUM', [client], { retries: 0 }) };
}

it.each([false, true])(
  'round-trips complete/failed state through Parquet, JSON, PDF and resume (%s)',
  async (fail) => {
    const store = new MemoryStore();
    const { client, rpc } = setup(fail);
    const s = enriched({ batchSize: 1 });
    const manifest = await new ExtractionRunner(s, rpc, store).run();
    expect(manifest).toMatchObject({
      schemaVersion: '3',
      complete: true,
      rowCount: 2,
      stateEnrichment: {
        enabled: true,
        failurePolicy: 'record_null_and_continue',
        reference: 'end_of_previous_block',
        ratioEncoding: 'reduced_unsigned_rational_string',
        ratioZeroDenominator: 'null',
      },
    });
    expect(features).toContain('senderBalanceEqualsAmount');
    for (const field of ['stateBlockNumber', 'stateEnrichmentStatus', 'stateEnrichmentReason']) {
      expect(audit).toContain(field);
      expect(features).not.toContain(field);
    }
    const rows = store.json('transactions.json');
    expect(rows[0]).toMatchObject({
      gasUsed: '25000',
      stateBlockNumber: '8',
      schemaVersion: '3',
      tokenAmount: String(huge),
      isZeroAmount: 0,
      isSelfTransfer: 1,
      senderHasEnoughBalance: fail ? null : 1,
      amountToSenderBalanceRatio: fail ? null : '1/1',
      stateEnrichmentStatus: fail ? 'failed' : 'complete',
      senderTokenBalanceBeforeBlock: fail ? null : String(huge),
      recipientTokenBalanceBeforeBlock: fail ? null : String(huge),
      recipientBalanceWasZero: fail ? null : 0,
      senderBalanceEqualsAmount: fail ? null : 1,
    });
    expect(rows[1].stateBlockNumber).toBe('9');
    const bytes = store.files.get(manifest.parts[0].file)!;
    const decoded = await parquetReadObjects({
      file: bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
    });
    expect(decoded).toEqual(rows.slice(0, 1));
    const pdf = await pdfText(store.files.get('report.pdf')!);
    expect(pdf).toContain(fail ? 'failed: 2' : 'complete: 2');
    expect(pdf).toContain('Earlier same-block'.toLowerCase().slice(0, 7));
    expect(JSON.stringify(manifest) + JSON.stringify(rows) + pdf).not.toMatch(
      /private.test|secret/,
    );
    vi.mocked(client.getTokenBalance).mockClear();
    vi.mocked(client.getReceipt).mockClear();
    await new ExtractionRunner(s, rpc, store).run();
    expect(store.json('transactions.json')).toEqual(rows);
    expect(client.getTokenBalance).not.toHaveBeenCalled();
    expect(client.getReceipt).not.toHaveBeenCalled();
  },
);

it('persists not-applicable rows with disabled enrichment and unchanged observed target', async () => {
  const store = new MemoryStore();
  const { client, rpc } = setup();
  await new ExtractionRunner(selection(), rpc, store).run();
  expect(client.getTokenBalance).not.toHaveBeenCalled();
  for (const row of store.json('transactions.json')) {
    expect(row).toMatchObject({
      stateEnrichmentStatus: 'not_applicable',
      stateEnrichmentReason: 'disabled',
      senderTokenBalanceBeforeBlock: null,
      recipientBalanceWasZero: null,
      stateBlockNumber: null,
      gasUsed: '25000',
      tokenAmount: null,
      isZeroAmount: null,
      isSelfTransfer: null,
      senderHasEnoughBalance: null,
      amountToSenderBalanceRatio: null,
    });
  }
});

it('exports true zero-balance indicators as numeric ones, with exact zero strings', async () => {
  const store = new MemoryStore();
  const { client, rpc } = setup();
  const recipient = '0x' + 'ef'.repeat(20);
  vi.mocked(client.getBlock).mockImplementation(async (height) =>
    block(height, [
      tx(height, {
        input: `0xa9059cbb${recipient.slice(2).padStart(64, '0')}${'0'.repeat(64)}`,
      }),
    ]),
  );
  vi.mocked(client.getTokenBalance).mockResolvedValue(0n);
  await new ExtractionRunner(enriched(), rpc, store).run();
  expect(store.json('transactions.json')[0]).toMatchObject({
    stateEnrichmentStatus: 'complete',
    senderTokenBalanceBeforeBlock: '0',
    recipientTokenBalanceBeforeBlock: '0',
    senderBalanceEqualsAmount: 1,
    recipientBalanceWasZero: 1,
    tokenAmount: '0',
    isZeroAmount: 1,
    isSelfTransfer: 0,
    senderHasEnoughBalance: 1,
    amountToSenderBalanceRatio: null,
  });
});

it('regenerates enriched Parquet from internal JSON batches without new state reads', async () => {
  const store = new MemoryStore();
  const { client, rpc } = setup();
  await new ExtractionRunner(enriched({ outputFormats: ['json'] }), rpc, store).run();
  const original = store.json('transactions.json');
  vi.mocked(client.getTokenBalance).mockClear();
  const manifest = await new ExtractionRunner(enriched(), rpc, store).run();
  expect(manifest.outputs.parquetFiles).toHaveLength(1);
  const rows = await new CheckpointRepository(store, enriched()).readPart(manifest.parts[0]);
  expect(rows).toEqual(original);
  expect(client.getTokenBalance).not.toHaveBeenCalled();
});

it.each([
  [2n, 3n, '2/3'],
  [0n, 3n, '0/1'],
  [0n, 0n, null],
  [2n, 0n, null],
] as const)(
  'preserves ratio %s/%s across JSON, Parquet regeneration and resume',
  async (value, balance, ratio) => {
    const store = new MemoryStore();
    const { client, rpc } = setup();
    vi.mocked(client.getBlock).mockImplementation(async (height) =>
      block(height, [
        tx(height, {
          input: `0xa9059cbb${other.slice(2).padStart(64, '0')}${value.toString(16).padStart(64, '0')}`,
        }),
      ]),
    );
    vi.mocked(client.getTokenBalance).mockResolvedValue(balance);
    await new ExtractionRunner(enriched({ outputFormats: ['json'] }), rpc, store).run();
    const rows = store.json('transactions.json');
    expect(rows[0]).toMatchObject({
      tokenAmount: String(value),
      amountToSenderBalanceRatio: ratio,
      senderTokenBalanceBeforeBlock: String(balance),
      stateEnrichmentStatus: 'complete',
      isZeroAmount: value === 0n ? 1 : 0,
      isSelfTransfer: 1,
      senderHasEnoughBalance: balance >= value ? 1 : 0,
    });
    vi.mocked(client.getTokenBalance).mockClear();
    const manifest = await new ExtractionRunner(
      enriched({ outputFormats: ['parquet', 'json'] }),
      rpc,
      store,
    ).run();
    const bytes = store.files.get(manifest.outputs.parquetFiles[0])!;
    const decoded = await parquetReadObjects({
      file: bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
    });
    expect(decoded).toEqual(rows);
    for (const name of [
      'tokenAmount',
      'isZeroAmount',
      'isSelfTransfer',
      'senderHasEnoughBalance',
      'amountToSenderBalanceRatio',
    ]) {
      expect(manifest.features).toContain(name);
      expect(manifest.audit).not.toContain(name);
      expect(manifest.physicalSchema.find((column) => column.name === name)).toMatchObject({
        type: name === 'tokenAmount' || name === 'amountToSenderBalanceRatio' ? 'STRING' : 'INT32',
        nullable: true,
      });
    }
    expect(client.getTokenBalance).not.toHaveBeenCalled();
  },
);

it.each([{ erc20BalanceEnrichment: false }, { contracts: [{ address, erc20: false }] }])(
  'rejects changed enrichment settings before modifying run files: %j',
  async (patch) => {
    const store = new MemoryStore();
    const { rpc } = setup();
    await new ExtractionRunner(enriched(), rpc, store).run();
    const original = [...store.files.entries()];
    await expect(new ExtractionRunner(enriched(patch), rpc, store).run()).rejects.toThrow(
      'Incompatible',
    );
    expect([...store.files.entries()]).toEqual(original);
    expect(new SelectionIdentity(enriched(patch)).fingerprint).not.toBe(
      new SelectionIdentity(enriched()).fingerprint,
    );
  },
);

it.each(['1', '2'])(
  'rejects schema-%s checkpoint and mixed schema rows, even in internal JSON state',
  async (oldVersion) => {
    const store = new MemoryStore();
    const { rpc } = setup();
    const s = enriched({ outputFormats: ['json'] });
    await new ExtractionRunner(s, rpc, store).run();
    const cp = store.json('checkpoint.json');
    cp.selection.schemaVersion = oldVersion;
    await store.commit('checkpoint.json', encodeJson(cp));
    const before = [...store.files.entries()];
    await expect(new ExtractionRunner(s, rpc, store).run()).rejects.toThrow('Incompatible');
    expect([...store.files.entries()]).toEqual(before);
    cp.selection.schemaVersion = '3';
    const part = cp.parts[0];
    const rows = store.json(part.file);
    rows[0].schemaVersion = oldVersion;
    const bytes = encodeJson(rows);
    await store.commit(part.file, bytes);
    part.sha256 = digest(bytes);
    await store.commit('checkpoint.json', encodeJson(cp));
    await expect(new ExtractionRunner(s, rpc, store).run()).rejects.toThrow('row schema');
  },
);

it('rejects missing v3 columns in committed JSON state', async () => {
  const store = new MemoryStore();
  const s = enriched({ outputFormats: ['json'] });
  const { rpc } = setup();
  await new ExtractionRunner(s, rpc, store).run();
  const cp = store.json('checkpoint.json'),
    part = cp.parts[0];
  const rows = store.json(part.file);
  delete rows[0].tokenAmount;
  const bytes = encodeJson(rows);
  await store.commit(part.file, bytes);
  part.sha256 = digest(bytes);
  await store.commit('checkpoint.json', encodeJson(cp));
  await expect(new ExtractionRunner(s, rpc, store).run()).rejects.toThrow('schema');
});

it('retains normalization of all original fields when adding empty state', () => {
  const t = tx();
  const row = new RowNormalizer('ETHEREUM').normalize({
    transaction: t,
    block: block(),
    receipt: receipt(t),
  });
  expect(row).toMatchObject({
    gasUsed: '25000',
    value: '0',
    input: t.input,
    to: address,
    from: other,
  });
});
