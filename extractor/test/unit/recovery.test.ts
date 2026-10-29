import { afterEach, describe, expect, it, vi } from 'vitest';
import { recoverRpc } from '../../src/recovery.js';
import { failureDetails, RpcReadError, rpcFailure } from '../../src/rpc-errors.js';
import { RPCManager, RpcClientFactory, InvalidData } from '../../src/rpc.js';
import { validateReceipt } from '../../src/extract.js';
import { block, receipt, tx, selection } from '../fixtures.js';
import { parseYaml, validateSelection } from '../../src/config.js';

afterEach(() => vi.unstubAllGlobals());
const settings = { batchRetries: 3, batchRetryDelayMs: 5000 };
const exhausted = () =>
  new RpcReadError('ETHEREUM', { category: 'invalid_response', operation: 'receipt', height: '9' });

describe('bounded RPC recovery', () => {
  it('backs off, reports the failed read and recovers a transient batch', async () => {
    const work = vi
      .fn()
      .mockRejectedValueOnce(exhausted())
      .mockRejectedValueOnce(exhausted())
      .mockResolvedValue('ok');
    const log = vi.fn(),
      sleep = vi.fn(async () => {});
    await expect(recoverRpc(work, settings, log, { nextBlock: '9' }, sleep)).resolves.toBe('ok');
    expect(sleep.mock.calls).toEqual([[5000], [10000]]);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'batch_retry',
        nextBlock: '9',
        operation: 'receipt',
        height: '9',
        attempt: 2,
      }),
    );
  });
  it('bounds retries and caps backoff at one minute', async () => {
    const work = vi.fn().mockRejectedValue(exhausted()),
      sleep = vi.fn(async () => {});
    await expect(
      recoverRpc(work, { ...settings, batchRetryDelayMs: 50000 }, vi.fn(), {}, sleep),
    ).rejects.toThrow('exhausted');
    expect(work).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls).toEqual([[50000], [60000], [60000]]);
  });
  it.each([new Error('disk failed'), new RpcReadError('ETHEREUM', { httpStatus: 401 }, false)])(
    'does not retry application or permanent authentication failures',
    async (error) => {
      const work = vi.fn().mockRejectedValue(error),
        sleep = vi.fn(async () => {});
      await expect(recoverRpc(work, settings, vi.fn(), {}, sleep)).rejects.toBe(error);
      expect(work).toHaveBeenCalledOnce();
      expect(sleep).not.toHaveBeenCalled();
    },
  );
  it('can disable batch recovery', async () => {
    const work = vi.fn().mockRejectedValue(exhausted());
    await expect(recoverRpc(work, { ...settings, batchRetries: 0 }, vi.fn(), {})).rejects.toThrow();
    expect(work).toHaveBeenCalledOnce();
  });
  it('keeps structured HTTP/RPC/validation diagnostics without provider text', () => {
    const secret = 'https://user:secret@rpc.test/token';
    const details = rpcFailure({
      message: secret,
      cause: { status: 429, code: -32005, message: secret },
    });
    expect(details).toMatchObject({ httpStatus: 429, rpcCode: -32005 });
    expect(rpcFailure(new InvalidData('receipt_identity'))).toMatchObject({
      category: 'invalid_response',
      reason: 'receipt_identity',
    });
    expect(JSON.stringify(details)).not.toContain(secret);
    expect(failureDetails({ code: 'ENOSPC', path: secret })).toEqual({ category: 'ENOSPC' });
    expect(failureDetails(new Error(secret))).toEqual({ category: 'application' });
  });
  it('validates recovery settings and keeps them outside checkpoint identity', () => {
    expect(selection()).toMatchObject(settings);
    const parsed = parseYaml(
      JSON.stringify(
        { ...selection(), fromBlock: '9', toBlock: '10', batchRetries: 2, batchRetryDelayMs: 1000 },
        (_, value) => (typeof value === 'bigint' ? String(value) : value),
      ),
    );
    expect(validateSelection(parsed)).toMatchObject({ batchRetries: 2, batchRetryDelayMs: 1000 });
    for (const patch of [
      { batchRetries: -1 },
      { batchRetries: 11 },
      { batchRetryDelayMs: 0 },
      { batchRetryDelayMs: 60001 },
    ])
      expect(() => selection(patch)).toThrow();
  });
  it('retries a null historical receipt through the real HTTP adapter', async () => {
    let receiptCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const request = JSON.parse(init!.body as string);
        let result: unknown;
        if (request.method === 'eth_chainId') result = '0x1';
        else if (request.method === 'eth_blockNumber') result = '0x64';
        else if (++receiptCalls === 1) result = null;
        else
          result = {
            ...receipt(),
            blockNumber: '0x9',
            transactionIndex: '0x0',
            gasUsed: '0x61a8',
            status: '0x1',
          };
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), {
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const progress = vi.fn();
    // A synthetic clock makes endpoint cooldown waits deterministic.
    let now = 0;
    const manager = new RPCManager(
      'ETHEREUM',
      new RpcClientFactory('ETHEREUM', 1000).create(['https://rpc.test']),
      {
        retries: 1,
        progress,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
    );
    await expect(
      manager.getReceipt(tx().hash, 9n, (r) => validateReceipt(r, tx(), block())),
    ).resolves.toMatchObject({ gasUsed: 25000n });
    expect(receiptCalls).toBe(2);
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'rpc_retry', category: 'receipt_unavailable' }),
    );
  });
});
