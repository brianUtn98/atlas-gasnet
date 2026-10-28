import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { mapConcurrent } from '../../src/concurrency.js';
import { ConsoleProgress, type ProgressEvent } from '../../src/progress.js';
import { RPCManager } from '../../src/rpc.js';
import { ExtractionRunner, type Store } from '../../src/persistence.js';
import { address, other, hash, selection, tx, block, receipt, fixtureClient } from '../fixtures.js';

afterEach(() => vi.useRealTimers());

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

async function extraction(concurrency: number) {
  const client = fixtureClient();
  let active = 0;
  let peak = 0;
  const methods = new Set<string>();
  const tracked = async <T>(method: string, value: () => T, ms = 2) => {
    active++;
    peak = Math.max(peak, active);
    methods.add(method);
    try {
      await delay(ms);
      return value();
    } finally {
      active--;
    }
  };
  const transactions = (height: bigint) =>
    Array.from({ length: 3 }, (_, index) =>
      tx(height, {
        hash: hash(Number(height) * 100 + index),
        transactionIndex: index,
        input: `0xa9059cbb${'ef'.repeat(20).padStart(64, '0')}${'1'.padStart(64, '0')}`,
      }),
    );
  client.getChainId = () => tracked('chain', () => 1);
  client.getBlockNumber = () => tracked('head', () => 100n);
  client.getBlock = (height) =>
    tracked('block', () => block(height, transactions(height)), height === 9n ? 8 : 2);
  client.getReceipt = (h) =>
    tracked('receipt', () => {
      const n = Number(BigInt(h));
      return receipt(transactions(BigInt(Math.floor(n / 100)))[n % 100]);
    });
  client.getTokenBalance = () => tracked('balance', () => 5n);
  const config = selection({
    toBlock: '12',
    rpcConcurrency: concurrency,
    erc20BalanceEnrichment: true,
    contracts: [{ address, erc20: true }],
    outputFormats: ['json'],
  });
  const events: ProgressEvent[] = [];
  const rpc = new RPCManager('ETHEREUM', [client], {
    ...config,
    progress: (event) => events.push(event),
  });
  const store = new MemoryStore();
  const result = await new ExtractionRunner(config, rpc, store, undefined, (event) =>
    events.push(event),
  ).run();
  return {
    peak,
    active,
    methods,
    result,
    rows: store.json('transactions.json'),
    events,
    metrics: rpc.metrics(),
  };
}

it('pipelines extraction with a global bound across probes, blocks, receipts and both balances', async () => {
  const serial = await extraction(1);
  const parallel = await extraction(3);
  expect(serial.peak).toBe(1);
  expect(parallel.peak).toBe(3);
  expect(parallel.active).toBe(0);
  expect(parallel.methods).toEqual(new Set(['chain', 'head', 'block', 'receipt', 'balance']));
  expect(parallel.rows).toEqual(serial.rows);
  expect(parallel.metrics).toMatchObject({
    requests: 26,
    inFlight: 0,
    peakInFlight: 3,
    probeRequests: 2,
    blockRequests: 4,
    receiptRequests: 12,
    balanceRequests: 8,
  });
  expect(parallel.result).toMatchObject({ complete: true, rowCount: 12, lastCommittedBlock: '12' });
  expect(
    parallel.events.some((event) => event.phase === 'scan' && Number(event.receiptsRead) > 0),
  ).toBe(true);
  expect(parallel.events.filter((event) => event.phase === 'enrich')).toHaveLength(12);
  expect(parallel.events.at(-1)).toMatchObject({
    phase: 'complete',
    percent: 100,
    committedBlocks: '4',
    rows: 12,
  });
});

it('drains in-flight workers after an error without starting the remaining work', async () => {
  const started: number[] = [];
  let finished = false;
  const work = mapConcurrent([0, 1, 2, 3], 2, async (value) => {
    started.push(value);
    if (value === 0) throw new Error('failed');
    await delay(5);
    finished = true;
    return value;
  });
  await expect(work).rejects.toThrow('failed');
  expect(started).toEqual([0, 1]);
  expect(finished).toBe(true);
});

it('retains physical permits after a wrapper timeout and bounds queue waits', async () => {
  vi.useFakeTimers();
  const client = fixtureClient();
  const rpc = new RPCManager('ETHEREUM', [client], {
    retries: 0,
    rpcConcurrency: 1,
    probeTimeoutMs: 100,
  });
  await rpc.refresh();
  let finish!: (value: bigint) => void;
  vi.mocked(client.getTokenBalance).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const first = rpc.getTokenBalance(address, other, 8n);
  const firstError = expect(first).rejects.toThrow('exhausted');
  await vi.advanceTimersByTimeAsync(100);
  await firstError;
  const second = rpc.getTokenBalance(address, other, 8n);
  const secondError = expect(second).rejects.toThrow('exhausted');
  await vi.advanceTimersByTimeAsync(1000);
  await secondError;
  expect(client.getTokenBalance).toHaveBeenCalledTimes(1);
  expect(rpc.metrics().peakInFlight).toBe(1);
  finish(0n);
  await vi.runAllTimersAsync();
  expect(await rpc.getTokenBalance(address, other, 8n)).toBe(0n);
});

it('applies Retry-After to already queued historical calls without cooling down unrelated endpoints', async () => {
  vi.useFakeTimers();
  const client = fixtureClient();
  const rpc = new RPCManager('ETHEREUM', [client], { retries: 1, rpcConcurrency: 1 });
  await rpc.refresh();
  vi.mocked(client.getTokenBalance)
    .mockRejectedValueOnce({ headers: { 'retry-after': '2' } })
    .mockResolvedValue(1n);
  const reads = Promise.all([
    rpc.getTokenBalance(address, other, 8n),
    rpc.getTokenBalance(address, address, 8n),
  ]);
  await vi.advanceTimersByTimeAsync(1999);
  expect(client.getTokenBalance).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await expect(reads).resolves.toEqual([1n, 1n]);
  expect(rpc.metrics().peakInFlight).toBe(1);
});

it('skips retries for permanent structured errors and keeps URLs/errors out of log events', async () => {
  const client = fixtureClient();
  const events: ProgressEvent[] = [];
  vi.mocked(client.getTokenBalance).mockRejectedValue({
    cause: { code: -32602, message: 'https://user:secret@private.test/token' },
  });
  const rpc = new RPCManager('ETHEREUM', [client], {
    retries: 3,
    progress: (event) => events.push(event),
  });
  await expect(rpc.getTokenBalance(address, other, 8n)).rejects.toThrow('exhausted');
  expect(client.getTokenBalance).toHaveBeenCalledOnce();
  expect(events[0]).toMatchObject({ phase: 'rpc_rejected', endpoint: 1, operation: 'balance' });
  expect(JSON.stringify(events)).not.toMatch(/secret|private.test|https/);
});

it('preserves a probe Retry-After when a simultaneous probe fails for a different reason', async () => {
  vi.useFakeTimers();
  const client = fixtureClient();
  vi.mocked(client.getChainId).mockRejectedValue({ status: 500 });
  vi.mocked(client.getBlockNumber).mockRejectedValue({ headers: { 'retry-after': '2' } });
  const rpc = new RPCManager('ETHEREUM', [client], { rpcConcurrency: 2 });
  const now = Date.now();
  await rpc.refresh();
  expect(rpc.snapshot()[0].cooldownUntil).toBe(now + 2000);
});

it('throttles intermediate console progress while printing durable milestones immediately', () => {
  const write = vi.fn();
  let now = 0;
  const progress = new ConsoleProgress(write, () => now);
  progress.report({ phase: 'start', totalBlocks: '10' });
  progress.report({ phase: 'scan', scannedBlocks: '1' });
  expect(write).toHaveBeenCalledTimes(1);
  now = 1000;
  progress.report({ phase: 'scan', scannedBlocks: '5', percent: 0, scannedPercent: 50 });
  progress.report({ phase: 'batch_committed', percent: 50, committedBlocks: '5' });
  progress.report({ phase: 'complete', percent: 100 });
  expect(write).toHaveBeenCalledTimes(4);
  expect(write.mock.calls[1][0]).toContain('scannedBlocks=5');
  expect(write.mock.calls.at(-1)![0]).toContain('percent=100');
});
