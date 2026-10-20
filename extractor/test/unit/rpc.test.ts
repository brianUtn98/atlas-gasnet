import { afterEach, describe, expect, it, vi } from 'vitest';
import { RPCManager, InvalidData, type ReadClient, type RpcBlock } from '../../src/rpc.js';
const hash = '0x' + '11'.repeat(32);
const block = (height = 99n): RpcBlock => ({
  number: height,
  hash,
  timestamp: 1n,
  transactions: [],
});
function client(head = 100n, chain = 1): ReadClient {
  return {
    getChainId: vi.fn(async () => chain),
    getTokenBalance: vi.fn(async () => 0n),
    getBlockNumber: vi.fn(async () => head),
    getBlock: vi.fn(async (h) => block(h)),
    getReceipt: vi.fn(),
  };
}
function manager(clients: ReadClient[], options = {}) {
  return new RPCManager('ETHEREUM', clients, { retries: 0, ...options });
}
afterEach(() => {
  vi.useRealTimers();
});
describe('read-only RPC manager', () => {
  it('supports a single endpoint and sanitized observations', async () => {
    const rpc = manager([client()]);
    await expect(rpc.getBlock(99n)).resolves.toEqual(block());
    expect(rpc.snapshot()[0]).toMatchObject({ index: 0, healthy: true, head: 100n });
    expect(Object.getOwnPropertyNames(RPCManager.prototype).join(' ')).not.toMatch(
      /send|sign|broadcast/i,
    );
    const snapshot = rpc.snapshot();
    snapshot[0].healthy = false;
    expect(rpc.snapshot()[0].healthy).toBe(true);
  });
  it('prefers newest head regardless of list order and breaks ties by order', async () => {
    const a = client(100n),
      b = client(105n);
    await manager([a, b]).getBlock(99n);
    expect(a.getBlock).not.toHaveBeenCalled();
    expect(b.getBlock).toHaveBeenCalledOnce();
    const c = client(105n);
    await manager([c, client(105n)]).getBlock(99n);
    expect(c.getBlock).toHaveBeenCalledOnce();
  });
  it('isolates network state and excludes mismatched chains', async () => {
    const wrong = client(900n, 137),
      correct = client(100n);
    await manager([wrong, correct]).getBlock(99n);
    expect(wrong.getBlock).not.toHaveBeenCalled();
    const polygon = new RPCManager('POLYGON', [wrong], { retries: 0 });
    await polygon.getBlock(99n);
    expect(wrong.getBlock).toHaveBeenCalledOnce();
  });
  it('refreshes expired observations and changes ranking', async () => {
    vi.useFakeTimers();
    const a = client(105n),
      b = client(100n);
    const rpc = manager([a, b], { healthRefreshIntervalMs: 1000 });
    await rpc.getBlock(99n);
    vi.mocked(b.getBlockNumber).mockResolvedValue(110n);
    await vi.advanceTimersByTimeAsync(1000);
    await rpc.getBlock(99n);
    expect(a.getBlock).toHaveBeenCalledTimes(1);
    expect(b.getBlock).toHaveBeenCalledTimes(1);
    expect(a.getChainId).toHaveBeenCalledTimes(2);
  });
  it('coalesces overlapping refreshes', async () => {
    const c = client();
    const rpc = manager([c]);
    await Promise.all([rpc.refresh(), rpc.refresh(), rpc.refresh()]);
    expect(c.getChainId).toHaveBeenCalledOnce();
  });
  it('bounds one stalled probe without a global failure and re-admits it later', async () => {
    vi.useFakeTimers();
    const stalled = client(110n),
      healthy = client(100n);
    vi.mocked(stalled.getChainId).mockImplementationOnce(() => new Promise(() => {}));
    const rpc = manager([stalled, healthy], { probeTimeoutMs: 100, healthRefreshIntervalMs: 1000 });
    const read = rpc.getBlock(99n);
    await vi.advanceTimersByTimeAsync(100);
    await read;
    expect(healthy.getBlock).toHaveBeenCalledOnce();
    expect(stalled.getBlock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    await rpc.getBlock(99n);
    expect(stalled.getBlock).toHaveBeenCalledOnce();
  });
  it('recovers lagging endpoints with bounded refreshes', async () => {
    vi.useFakeTimers();
    const c = client(90n);
    vi.mocked(c.getBlockNumber).mockResolvedValueOnce(90n).mockResolvedValue(100n);
    const read = manager([c], { retries: 1 }).getBlock(99n);
    await vi.advanceTimersByTimeAsync(250);
    await expect(read).resolves.toEqual(block());
    const low = client(90n);
    const failed = manager([low], { retries: 1 }).getBlock(99n);
    const assertion = expect(failed).rejects.toThrow('exhausted');
    await vi.runAllTimersAsync();
    await assertion;
    expect(low.getBlock).not.toHaveBeenCalled();
    expect(low.getChainId).toHaveBeenCalledTimes(2);
  });
  it('honors bounded Retry-After and retries transient failures', async () => {
    vi.useFakeTimers();
    const c = client();
    vi.mocked(c.getBlock)
      .mockRejectedValueOnce({ headers: { 'retry-after': '2' } })
      .mockResolvedValue(block());
    const read = manager([c], { retries: 1 }).getBlock(99n);
    await vi.advanceTimersByTimeAsync(1999);
    expect(c.getBlock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await read;
    expect(c.getBlock).toHaveBeenCalledTimes(2);
  });
  it('caps Retry-After dates and large values', async () => {
    vi.useFakeTimers();
    const c = client();
    vi.mocked(c.getBlock)
      .mockRejectedValueOnce({ cause: { retryAfter: new Date(Date.now() + 100000).toUTCString() } })
      .mockResolvedValue(block());
    const read = manager([c], { retries: 1 }).getBlock(99n);
    await vi.advanceTimersByTimeAsync(30000);
    await read;
    expect(c.getBlock).toHaveBeenCalledTimes(2);
  });
  it('exhausts retries then falls back without leaking credentials', async () => {
    vi.useFakeTimers();
    const a = client(110n),
      b = client();
    const secret = 'https://user:password@rpc.test/token?api_key=secret';
    vi.mocked(a.getBlock).mockRejectedValue(new Error(secret));
    const rpc = manager([a, b], { retries: 2 });
    const read = rpc.getBlock(99n);
    await vi.runAllTimersAsync();
    await read;
    expect(a.getBlock).toHaveBeenCalledTimes(3);
    expect(b.getBlock).toHaveBeenCalledOnce();
    const fail = manager([a]);
    await expect(fail.getBlock(99n)).rejects.toThrow(
      /^RPC reads exhausted for ETHEREUM; no progress committed\.$/,
    );
    expect(
      JSON.stringify(rpc.snapshot(), (_, v) => (typeof v === 'bigint' ? String(v) : v)),
    ).not.toContain(secret);
  });
  it.each(['missing', 'wrong-height', 'malformed'])(
    'rejects %s historical blocks immediately and never loops back',
    async (kind) => {
      const a = client(110n),
        b = client();
      vi.mocked(a.getBlock).mockResolvedValue(
        (kind === 'missing'
          ? null
          : kind === 'wrong-height'
            ? block(100n)
            : { ...block(), hash: 'broken' }) as unknown as RpcBlock,
      );
      await manager([a, b], { retries: 3 }).getBlock(99n);
      expect(a.getBlock).toHaveBeenCalledOnce();
      expect(b.getBlock).toHaveBeenCalledOnce();
    },
  );
  it('uses caller validation for anchored receipts and bounds all rejected endpoints', async () => {
    const a = client(110n),
      b = client();
    vi.mocked(a.getReceipt).mockResolvedValue(null as never);
    vi.mocked(b.getReceipt).mockResolvedValue({
      transactionHash: hash,
      blockNumber: 99n,
      blockHash: hash,
    } as never);
    await manager([a, b], { retries: 0 }).getReceipt(hash, 99n, () => {});
    expect(a.getReceipt).toHaveBeenCalledOnce();
    await expect(
      manager([b]).getReceipt(hash, 99n, () => {
        throw new InvalidData();
      }),
    ).rejects.toThrow('exhausted');
  });
});
