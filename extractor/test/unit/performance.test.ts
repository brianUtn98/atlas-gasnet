import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdaptiveConcurrency } from '../../src/adaptive-concurrency.js';
import { ConcurrencyLimiter } from '../../src/concurrency.js';
import { Erc20BalanceEnricher } from '../../src/enrichment.js';
import { RPCManager, RpcClientFactory } from '../../src/rpc.js';
import { SelectionIdentity } from '../../src/identity.js';
import { parseYaml, validateSelection } from '../../src/config.js';
import { address, other, hash, block, fixtureClient, receipt, selection, tx } from '../fixtures.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const recipient = '0x' + 'ef'.repeat(20);
function match(height = 9n, blockHash = hash(Number(height))) {
  const transaction = tx(height, {
    input: `0xa9059cbb${recipient.slice(2).padStart(64, '0')}${'1'.padStart(64, '0')}`,
    blockHash,
  });
  return {
    transaction,
    block: { ...block(height, [transaction]), hash: blockHash },
    receipt: receipt(transaction),
  };
}
const enabled = (patch = {}) =>
  selection({ erc20BalanceEnrichment: true, contracts: [{ address, erc20: true }], ...patch });

describe('single-flight historical balances', () => {
  it('coalesces in-flight requests and retains exact zero/uint256 values', async () => {
    const client = fixtureClient();
    vi.mocked(client.getTokenBalance).mockImplementation(async (_token, owner) =>
      owner === other ? 0n : (1n << 256n) - 1n,
    );
    const enricher = new Erc20BalanceEnricher(enabled(), new RPCManager('ETHEREUM', [client]));
    const rows = await Promise.all(Array.from({ length: 10 }, () => enricher.enrich(match())));
    expect(rows.every((row) => row.stateEnrichmentStatus === 'complete')).toBe(true);
    expect(rows[0].senderTokenBalanceBeforeBlock).toBe('0');
    expect(rows[0].recipientTokenBalanceBeforeBlock).toBe(String((1n << 256n) - 1n));
    expect(client.getTokenBalance).toHaveBeenCalledTimes(2);
    expect(enricher.metrics()).toMatchObject({ balanceCacheHits: 18, balanceCacheMisses: 2 });
  });
  it('never reuses a different block/hash/contract/owner or another batch instance', async () => {
    const client = fixtureClient();
    const rpc = new RPCManager('ETHEREUM', [client]);
    const config = enabled({
      contracts: [
        { address, erc20: true },
        { address: recipient, erc20: true },
      ],
    });
    const enricher = new Erc20BalanceEnricher(config, rpc);
    await enricher.enrich(match());
    await enricher.enrich(match(10n));
    await enricher.enrich(match(9n, hash(99)));
    const changed = match();
    changed.transaction.to = recipient;
    await enricher.enrich(changed);
    const ownerChanged = match();
    ownerChanged.transaction.from = address;
    await enricher.enrich(ownerChanged);
    await new Erc20BalanceEnricher(config, rpc).enrich(match());
    expect(client.getTokenBalance).toHaveBeenCalledTimes(11);
  });
  it('evicts failed promises and bounds capacity without evicting in-flight entries', async () => {
    const client = fixtureClient();
    vi.mocked(client.getTokenBalance)
      .mockRejectedValueOnce(Error('unavailable'))
      .mockResolvedValue(2n);
    const enricher = new Erc20BalanceEnricher(
      enabled({ rpcBalanceCacheSize: 1 }),
      new RPCManager('ETHEREUM', [client], { retries: 0 }),
    );
    expect((await enricher.enrich(match())).stateEnrichmentStatus).toBe('failed');
    expect((await enricher.enrich(match())).stateEnrichmentStatus).toBe('complete');
    await enricher.enrich(match(10n));
    expect(enricher.metrics().balanceCacheEntries).toBeLessThanOrEqual(1);
    expect(vi.mocked(client.getTokenBalance).mock.calls.length).toBeGreaterThanOrEqual(4);
  });
  it('can disable caching for comparison', async () => {
    const client = fixtureClient();
    const enricher = new Erc20BalanceEnricher(
      enabled({ rpcBalanceCacheSize: 0 }),
      new RPCManager('ETHEREUM', [client]),
    );
    await Promise.all([enricher.enrich(match()), enricher.enrich(match())]);
    expect(client.getTokenBalance).toHaveBeenCalledTimes(4);
    expect(enricher.metrics().balanceCacheEntries).toBe(0);
  });
});

describe('adaptive request limits', () => {
  it.each([true, false])(
    'honors real HTTP 429 cooldown and adaptive opt-out (%s)',
    async (adaptive) => {
      vi.useFakeTimers();
      let calls = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url, init) => {
          const job = JSON.parse(String(init?.body));
          if (job.method === 'eth_call' && calls++ === 0)
            return new Response(JSON.stringify({ error: { code: -32000, message: 'limited' } }), {
              status: 429,
              headers: { 'content-type': 'application/json', 'retry-after': '2' },
            });
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: job.id,
              result:
                job.method === 'eth_chainId'
                  ? '0x1'
                  : job.method === 'eth_blockNumber'
                    ? '0x64'
                    : '0x' + '5'.padStart(64, '0'),
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        }),
      );
      const rpc = new RPCManager(
        'ETHEREUM',
        new RpcClientFactory('ETHEREUM', 1000).create(['https://fixture.invalid']),
        { rpcConcurrency: 8, rpcAdaptiveConcurrency: adaptive, retries: 1 },
      );
      await rpc.refresh();
      const pending = rpc.getTokenBalance(address, other, 8n);
      await vi.advanceTimersByTimeAsync(1999);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toBe(5n);
      expect(rpc.metrics()).toMatchObject({ concurrencyLimit: adaptive ? 4 : 8, retries: 1 });
    },
  );
  it('decreases once per congestion window and recovers additively within the configured maximum', () => {
    const limiter = new ConcurrencyLimiter(8);
    const report = vi.fn();
    let now = 0;
    const control = new AdaptiveConcurrency(limiter, 8, report, () => now);
    control.congested('rate_limit');
    expect(limiter.currentLimit).toBe(4);
    control.congested('rate_limit');
    expect(limiter.currentLimit).toBe(4);
    now = 1000;
    control.congested('timeout');
    expect(limiter.currentLimit).toBe(2);
    now = 2000;
    for (let i = 0; i < 16; i++) control.succeeded(10, 1000);
    expect(limiter.currentLimit).toBe(3);
    for (let round = 0; round < 10; round++) {
      now += 1000;
      for (let i = 0; i < 32; i++) control.succeeded(10, 1000);
    }
    expect(limiter.currentLimit).toBe(8);
    control.succeeded(900, 1000);
    expect(limiter.currentLimit).toBe(4);
    control.succeeded(900, 1000);
    expect(limiter.currentLimit).toBe(4);
    now += 1000;
    control.succeeded(900, 1000);
    expect(limiter.currentLimit).toBe(2);
    expect(report.mock.calls.some(([event]) => event.reason === 'recovery')).toBe(true);
  });
  it('does not admit queued requests until active work drains below a reduced limit', async () => {
    const limiter = new ConcurrencyLimiter(2);
    const first = await limiter.acquire(),
      second = await limiter.acquire();
    let started = false;
    const queued = limiter.acquire().then((release) => {
      started = true;
      return release;
    });
    limiter.setLimit(1);
    first();
    await Promise.resolve();
    expect(started).toBe(false);
    second();
    const release = await queued;
    expect(started).toBe(true);
    release();
  });
});

describe('HTTP batches through the real viem adapter', () => {
  function clients(fetchMock: typeof fetch) {
    vi.stubGlobal('fetch', fetchMock);
    return new RpcClientFactory('ETHEREUM', 1000, { rpcBatchSize: 8, rpcBatchWaitMs: 0 }).create([
      'https://fixture.invalid',
    ]);
  }
  const result = (job: { id: unknown; params: { data: string }[] }) => ({
    jsonrpc: '2.0',
    id: job.id,
    result: '0x' + (job.params[0].data.endsWith(other.slice(2)) ? '1' : '2').padStart(64, '0'),
  });
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  it('keeps fallback HTTP requests within the global logical permit limit', async () => {
    let active = 0,
      peak = 0;
    const [client] = clients(
      vi.fn(async (_url, init) => {
        active++;
        peak = Math.max(peak, active);
        try {
          await new Promise((resolve) => setTimeout(resolve, 2));
          const job = JSON.parse(String(init?.body));
          if (Array.isArray(job))
            return json({ jsonrpc: '2.0', id: null, error: { code: -32600 } });
          return json({
            jsonrpc: '2.0',
            id: job.id,
            result:
              job.method === 'eth_chainId'
                ? '0x1'
                : job.method === 'eth_blockNumber'
                  ? '0x64'
                  : '0x' + '5'.padStart(64, '0'),
          });
        } finally {
          active--;
        }
      }),
    );
    const rpc = new RPCManager('ETHEREUM', [client], { rpcConcurrency: 3, retries: 0 });
    const balances = await Promise.all(
      Array.from({ length: 12 }, () => rpc.getTokenBalance(address, other, 8n)),
    );
    expect(balances).toEqual(Array(12).fill(5n));
    expect(peak).toBe(3);
    expect(active).toBe(0);
    expect(rpc.metrics()).toMatchObject({
      requests: 14,
      httpRequests: 15,
      batchFallbacks: 1,
      peakInFlight: 3,
    });
  });

  it('maps out-of-order batch IDs to the right owner and reduces HTTP envelopes', async () => {
    const fetchMock = vi.fn(async (_url, init) => {
      const jobs = JSON.parse(String(init?.body));
      return json(jobs.map(result).reverse());
    });
    const [client] = clients(fetchMock);
    expect(
      await Promise.all([
        client.getTokenBalance(address, other, 8n),
        client.getTokenBalance(address, address, 8n),
      ]),
    ).toEqual([1n, 2n]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(client.metrics?.()).toMatchObject({
      httpRequests: 1,
      httpBatches: 1,
      batchFallbacks: 0,
    });
  });
  it.each(['json-error', 'plain-http-error', 'provider-quota'])(
    'falls back and remembers unsupported batching (%s)',
    async (failure) => {
      let batchCalls = 0;
      const fetchMock = vi.fn(async (_url, init) => {
        const job = JSON.parse(String(init?.body));
        if (Array.isArray(job)) {
          batchCalls++;
          if (failure === 'provider-quota')
            return json(
              job.map((entry) => ({
                jsonrpc: '2.0',
                id: entry.id,
                error: { code: 31, message: 'batch quota' },
              })),
              500,
            );
          return failure === 'json-error'
            ? json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'unsupported' } })
            : new Response('unsupported batch', { status: 400 });
        }
        return json(result(job));
      });
      const [client] = clients(fetchMock);
      for (let i = 0; i < 2; i++)
        expect(
          await Promise.all([
            client.getTokenBalance(address, other, 8n),
            client.getTokenBalance(address, address, 8n),
          ]),
        ).toEqual([1n, 2n]);
      expect(batchCalls).toBe(1);
      expect(client.metrics?.()).toMatchObject({ httpRequests: 5, batchFallbacks: 1 });
    },
  );
  it('does not amplify transient HTTP 500 errors with individual retries', async () => {
    const [client] = clients(
      vi.fn(async (_url, init) => {
        const jobs = JSON.parse(String(init?.body));
        return json(
          jobs.map((job: { id: unknown }) => ({
            jsonrpc: '2.0',
            id: job.id,
            error: { code: -32000, message: 'temporary failure' },
          })),
          500,
        );
      }),
    );
    await expect(client.getTokenBalance(address, other, 8n)).rejects.toThrow();
    expect(client.metrics?.()).toMatchObject({ httpRequests: 1, batchFallbacks: 0 });
  });
  it('retains per-call RPC errors without repeating successful batch calls', async () => {
    const [client] = clients(
      vi.fn(async (_url, init) => {
        const jobs = JSON.parse(String(init?.body));
        return json([
          result(jobs[0]),
          { jsonrpc: '2.0', id: jobs[1].id, error: { code: -32602, message: 'bad input' } },
        ]);
      }),
    );
    const results = await Promise.allSettled([
      client.getTokenBalance(address, other, 8n),
      client.getTokenBalance(address, address, 8n),
    ]);
    expect(results[0]).toEqual({ status: 'fulfilled', value: 1n });
    expect(results[1].status).toBe('rejected');
    expect(client.metrics?.().httpRequests).toBe(1);
  });
  it.each(['missing', 'duplicate', 'wrong'])(
    'rejects %s response IDs before any balance is accepted',
    async (kind) => {
      const [client] = clients(
        vi.fn(async (_url, init) => {
          const jobs = JSON.parse(String(init?.body));
          const responses = jobs.map(result);
          if (kind === 'missing') responses.pop();
          if (kind === 'duplicate') responses[1].id = responses[0].id;
          if (kind === 'wrong') responses[1].id = -1;
          return json(responses);
        }),
      );
      const outcomes = await Promise.allSettled([
        client.getTokenBalance(address, other, 8n),
        client.getTokenBalance(address, address, 8n),
      ]);
      expect(outcomes.every((outcome) => outcome.status === 'rejected')).toBe(true);
    },
  );
  it('preserves HTTP 429 Retry-After metadata even with a JSON-RPC error body, without fallback amplification', async () => {
    const [client] = clients(
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: -32000, message: 'limited' } }), {
            status: 429,
            headers: { 'content-type': 'application/json', 'retry-after': '2' },
          }),
      ),
    );
    let failure: unknown;
    try {
      await client.getTokenBalance(address, other, 8n);
    } catch (error) {
      failure = error;
    }
    let cause = failure as { cause?: unknown; headers?: Headers } | undefined;
    for (let i = 0; i < 5 && cause && !cause.headers; i++) cause = cause.cause as typeof cause;
    expect(cause?.headers?.get('retry-after')).toBe('2');
    expect(client.metrics?.()).toMatchObject({ httpRequests: 1, batchFallbacks: 0 });
  });
});

it('validates tuning settings and leaves checkpoint selection fingerprints unchanged', () => {
  const base = selection();
  const tuned = selection({
    rpcConcurrency: 16,
    rpcBatchSize: 8,
    rpcBatchWaitMs: 0,
    rpcBalanceCacheSize: 0,
    rpcAdaptiveConcurrency: false,
  });
  expect(new SelectionIdentity(base).fingerprint).toBe(new SelectionIdentity(tuned).fingerprint);
  for (const patch of [
    { rpcBatchSize: 0 },
    { rpcBatchSize: 33 },
    { rpcBatchWaitMs: -1 },
    { rpcBatchWaitMs: 101 },
    { rpcBalanceCacheSize: -1 },
    { rpcBalanceCacheSize: 100001 },
    { rpcAdaptiveConcurrency: 'true' },
  ])
    expect(() => selection(patch)).toThrow();
  const parsed = parseYaml(
    JSON.stringify({
      network: 'ETHEREUM',
      fromBlock: '9',
      toBlock: '10',
      contracts: [{ address }],
      outputDir: 'test',
      rpcBatchSize: 8,
      rpcBalanceCacheSize: 123,
    }),
  );
  expect(validateSelection(parsed)).toMatchObject({ rpcBatchSize: 8, rpcBalanceCacheSize: 123 });
});
