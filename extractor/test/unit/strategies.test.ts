import { expect, it, vi } from 'vitest';
import { ExtractionRunner } from '../../src/persistence.js';
import { OutputManager } from '../../src/output/manager.js';
import { ParquetOutputStrategy } from '../../src/output/parquet.js';
import { PdfOutputStrategy } from '../../src/output/pdf.js';
import type { OutputContext, OutputStrategy } from '../../src/output/strategy.js';
import { ParquetCodec, type ParquetEncoder } from '../../src/parquet.js';
import { RowNormalizer } from '../../src/rows.js';
import { RPCManager } from '../../src/rpc.js';
import { encodeJson } from '../../src/serialization.js';
import type { Store } from '../../src/store.js';
import { block, fixtureClient, receipt, selection, tx } from '../fixtures.js';
import { reportManifest } from '../report-helpers.js';

class StrategyStore implements Store {
  readonly files = new Map<string, Uint8Array>();

  async list() {
    return [...this.files.keys()];
  }
  async read(name: string) {
    return this.files.get(name) ?? null;
  }
  async commit(name: string, bytes: Uint8Array) {
    this.files.set(name, bytes);
  }
}

function context(): OutputContext {
  const transaction = tx();
  const rows = [
    new RowNormalizer('ETHEREUM').normalize({
      transaction,
      block: block(),
      receipt: receipt(transaction),
    }),
  ];
  const manifest = reportManifest(rows);
  return {
    store: new StrategyStore(),
    checkpoint: {
      version: 1,
      fingerprint: manifest.fingerprint,
      selection: manifest.selection,
      batchSize: 100,
      nextBlock: '11',
      parts: manifest.parts,
    },
    manifest,
    rows,
    parts: { readPart: vi.fn(async () => rows) },
  };
}

it('injects a replacement strategy without changing the runner or its manifest logic', async () => {
  const write = vi.fn(async (input: OutputContext) =>
    input.store.commit('custom.json', encodeJson(input.rows)),
  );
  const strategy: OutputStrategy = { format: 'json', filenames: () => ['custom.json'], write };
  const unused: OutputStrategy = { format: 'pdf', filenames: () => ['unused.pdf'], write: vi.fn() };
  const store = new StrategyStore();
  const config = selection({ outputFormats: ['json'] });
  const rpc = new RPCManager(config.network, [fixtureClient()], { retries: 0 });
  const result = await new ExtractionRunner(
    config,
    rpc,
    store,
    new OutputManager([strategy, unused]),
  ).run();

  expect(result.outputs.jsonFile).toBe('custom.json');
  expect(write).toHaveBeenCalledOnce();
  expect(unused.write).not.toHaveBeenCalled();
  const rows = JSON.parse(new TextDecoder().decode(store.files.get('custom.json')));
  expect(rows.map((row: { blockNumber: string }) => row.blockNumber)).toEqual(['9', '10']);
  expect(store.files.has('transactions.json')).toBe(false);
});

it('rejects duplicate registrations and missing strategies before writing output', async () => {
  const strategy: OutputStrategy = {
    format: 'json',
    filenames: () => ['transactions.json'],
    write: vi.fn(),
  };
  expect(() => new OutputManager([strategy, strategy])).toThrow('Duplicate output strategy');
  const manager = new OutputManager([strategy]);
  expect(() => manager.describe(['pdf'], context().checkpoint)).toThrow('No output strategy');
  await expect(manager.write(context())).rejects.toThrow('No output strategy');
  expect(strategy.write).not.toHaveBeenCalled();
});

it('uses the injected Parquet codec for internal state parts and reuses existing Parquet', async () => {
  const input = context();
  const writer = vi.fn<ParquetEncoder>(() => new ArrayBuffer(4));
  const strategy = new ParquetOutputStrategy(new ParquetCodec(writer));
  await strategy.write(input);
  expect(input.parts.readPart).not.toHaveBeenCalled();
  expect(writer).not.toHaveBeenCalled();

  input.checkpoint.parts[0] = { ...input.checkpoint.parts[0], file: 'batch-9-10.checkpoint' };
  await strategy.write(input);
  expect(input.parts.readPart).toHaveBeenCalledExactlyOnceWith(input.checkpoint.parts[0]);
  expect(writer).toHaveBeenCalledOnce();
  expect(await input.store.read('part-9-10.parquet')).toHaveLength(4);
});

it('propagates renderer failure without committing an invalid PDF', async () => {
  const render = vi.fn(async (): Promise<Uint8Array> => {
    throw new Error('Renderer unavailable');
  });
  const input = context();
  await expect(new PdfOutputStrategy({ render }).write(input)).rejects.toThrow(
    'Renderer unavailable',
  );
  expect(await input.store.read('report.pdf')).toBeNull();
});
