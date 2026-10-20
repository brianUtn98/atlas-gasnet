import { afterEach, describe, expect, it, vi } from 'vitest';
import { Erc20BalanceEnricher, decodeTransfer, amountBalanceRatio } from '../../src/enrichment.js';
import { RPCManager, RpcClientFactory } from '../../src/rpc.js';
import { address, other, block, fixtureClient, receipt, selection, tx } from '../fixtures.js';

const recipient = '0x' + 'ef'.repeat(20);
const amount = 2n ** 200n + 1n;
const input = (to = recipient, value = amount) =>
  `0xa9059cbb${to.slice(2).padStart(64, '0')}${value.toString(16).padStart(64, '0')}`;
const enabled = (patch = {}) =>
  selection({ erc20BalanceEnrichment: true, contracts: [{ address, erc20: true }], ...patch });
const match = (data = input(), height = 9n) => {
  const transaction = tx(height, { input: data });
  return { transaction, block: block(height, [transaction]), receipt: receipt(transaction) };
};
afterEach(() => vi.unstubAllGlobals());

describe('ERC-20 state candidates', () => {
  it.each([
    [0n, 0n, 1, null],
    [1n, 0n, 0, null],
    [0n, 10n, 1, '0/1'],
    [5n, 10n, 1, '1/2'],
    [10n, 10n, 1, '1/1'],
    [11n, 10n, 0, '11/10'],
    [1n, 3n, 1, '1/3'],
    [9007199254740993n, 9007199254740992n, 0, '9007199254740993/9007199254740992'],
    [1n, (1n << 256n) - 1n, 1, `1/${(1n << 256n) - 1n}`],
    [(1n << 256n) - 1n, 1n, 0, `${(1n << 256n) - 1n}/1`],
  ] as const)(
    'computes exact transfer relationships for amount %s / balance %s',
    async (value, balance, enough, ratio) => {
      const client = fixtureClient();
      vi.mocked(client.getTokenBalance).mockResolvedValueOnce(balance).mockResolvedValueOnce(3n);
      const result = await new Erc20BalanceEnricher(
        enabled(),
        new RPCManager('ETHEREUM', [client]),
      ).enrich(match(input(recipient, value)));
      expect(result).toMatchObject({
        tokenAmount: String(value),
        isZeroAmount: value === 0n ? 1 : 0,
        isSelfTransfer: 0,
        senderHasEnoughBalance: enough,
        amountToSenderBalanceRatio: ratio,
        stateEnrichmentStatus: 'complete',
        stateBlockNumber: '8',
      });
      expect(client.getTokenBalance).toHaveBeenCalledTimes(2);
    },
  );
  it('handles a zero amount with distinct sender and recipient', async () => {
    const client = fixtureClient();
    const result = await new Erc20BalanceEnricher(
      enabled(),
      new RPCManager('ETHEREUM', [client]),
    ).enrich(match(input(recipient, 0n)));
    expect(result).toMatchObject({
      senderBalanceEqualsAmount: 1,
      recipientBalanceWasZero: 1,
      senderTokenBalanceBeforeBlock: '0',
      recipientTokenBalanceBeforeBlock: '0',
    });
    expect(client.getTokenBalance).toHaveBeenCalledTimes(2);
  });
  it('preserves the maximum uint256 amount and balances', async () => {
    const value = (1n << 256n) - 1n;
    const client = fixtureClient();
    vi.mocked(client.getTokenBalance).mockResolvedValue(value);
    const result = await new Erc20BalanceEnricher(
      enabled(),
      new RPCManager('ETHEREUM', [client]),
    ).enrich(match(input(recipient, value)));
    expect(result).toMatchObject({
      senderBalanceEqualsAmount: 1,
      senderTokenBalanceBeforeBlock: String(value),
    });
    expect(decodeTransfer(input(recipient, value).toUpperCase())?.amount).toBe(value);
  });
  it.each([
    [amount, 0n, 1, 1],
    [amount + 1n, 3n, 0, 0],
    [0n, 1n, 0, 0],
  ] as const)(
    'preserves exact balances and indicators: %s / %s',
    async (sender, receiver, zero, equals) => {
      const client = fixtureClient();
      vi.mocked(client.getTokenBalance)
        .mockResolvedValueOnce(sender)
        .mockResolvedValueOnce(receiver);
      const result = await new Erc20BalanceEnricher(
        enabled(),
        new RPCManager('ETHEREUM', [client]),
      ).enrich(match());
      expect(result).toEqual({
        tokenAmount: String(amount),
        isZeroAmount: 0,
        isSelfTransfer: 0,
        senderHasEnoughBalance: sender === 0n ? 0 : 1,
        amountToSenderBalanceRatio:
          sender === 0n ? null : sender === amount ? '1/1' : `${amount}/${amount + 1n}`,
        stateBlockNumber: '8',
        senderTokenBalanceBeforeBlock: String(sender),
        recipientTokenBalanceBeforeBlock: String(receiver),
        recipientBalanceWasZero: zero,
        senderBalanceEqualsAmount: equals,
        stateEnrichmentStatus: 'complete',
        stateEnrichmentReason: null,
      });
      expect(client.getTokenBalance).toHaveBeenNthCalledWith(1, address, other, 8n);
      expect(client.getTokenBalance).toHaveBeenNthCalledWith(2, address, recipient, 8n);
    },
  );
  it.each([0n, amount])('handles zero amounts and self transfers exactly (%s)', async (value) => {
    const client = fixtureClient();
    vi.mocked(client.getTokenBalance).mockResolvedValue(value);
    const result = await new Erc20BalanceEnricher(
      enabled(),
      new RPCManager('ETHEREUM', [client]),
    ).enrich(match(input(other, value)));
    expect(result).toMatchObject({
      senderBalanceEqualsAmount: 1,
      recipientBalanceWasZero: value === 0n ? 1 : 0,
      tokenAmount: String(value),
      isZeroAmount: value === 0n ? 1 : 0,
      isSelfTransfer: 1,
      senderHasEnoughBalance: 1,
      amountToSenderBalanceRatio: value === 0n ? null : '1/1',
      senderTokenBalanceBeforeBlock: String(value),
      recipientTokenBalanceBeforeBlock: String(value),
    });
    expect(client.getTokenBalance).toHaveBeenCalledOnce();
  });
  it.each([
    [selection(), input(), 'disabled'],
    [enabled({ contracts: [{ address }] }), input(), 'contract_not_enabled'],
    [enabled({ contracts: [{ address: other, erc20: true }] }), input(), 'contract_not_enabled'],
    [enabled(), '0x095ea7b3', 'other_function'],
    [enabled(), '0x23b872dd', 'other_function'],
    [enabled(), '0x', 'other_function'],
  ])('does not request state when not applicable', async (s, data, reason) => {
    const client = fixtureClient();
    const result = await new Erc20BalanceEnricher(s, new RPCManager('ETHEREUM', [client])).enrich(
      match(data),
    );
    expect(result).toMatchObject({
      stateEnrichmentStatus: 'not_applicable',
      stateEnrichmentReason: reason,
      stateBlockNumber: null,
      recipientBalanceWasZero: null,
      senderBalanceEqualsAmount: null,
      tokenAmount: null,
      isZeroAmount: null,
      isSelfTransfer: null,
      senderHasEnoughBalance: null,
      amountToSenderBalanceRatio: null,
    });
    expect(client.getTokenBalance).not.toHaveBeenCalled();
    expect(client.getChainId).not.toHaveBeenCalled();
  });
  it.each([
    '0xa9059cbb',
    input().slice(0, -2),
    input() + '00',
    input().replace('000000', '100000'),
    input().slice(0, -1) + 'z',
  ])('rejects malformed transfer %s', async (data) => {
    const client = fixtureClient();
    const result = await new Erc20BalanceEnricher(
      enabled(),
      new RPCManager('ETHEREUM', [client]),
    ).enrich(match(data));
    expect(result).toMatchObject({
      stateEnrichmentStatus: 'failed',
      stateEnrichmentReason: 'invalid_calldata',
      tokenAmount: null,
      isZeroAmount: null,
      isSelfTransfer: null,
      senderHasEnoughBalance: null,
      amountToSenderBalanceRatio: null,
    });
    expect(client.getTokenBalance).not.toHaveBeenCalled();
    expect(decodeTransfer(data)).toBeNull();
  });
  it('decodes a real USDC example without confusing tx.to with token recipient', () => {
    expect(
      decodeTransfer(
        '0xa9059cbb0000000000000000000000002fc617e933a52713247ce25730f6695920b3befe000000000000000000000000000000000000000000000000000000001dcd6500',
      ),
    ).toEqual({ recipient: '0x2fc617e933a52713247ce25730f6695920b3befe', amount: 500000000n });
  });
  it('rejects block zero and permits reference block zero for inclusion block one', async () => {
    const client = fixtureClient();
    const enrich = new Erc20BalanceEnricher(enabled(), new RPCManager('ETHEREUM', [client]));
    expect(await enrich.enrich(match(input(), 0n))).toMatchObject({
      stateEnrichmentStatus: 'failed',
      stateEnrichmentReason: 'invalid_state_block',
      stateBlockNumber: null,
      tokenAmount: String(amount),
      isSelfTransfer: 0,
      isZeroAmount: 0,
      senderHasEnoughBalance: null,
      amountToSenderBalanceRatio: null,
    });
    expect(client.getTokenBalance).not.toHaveBeenCalled();
    expect(await enrich.enrich(match(input(), 1n))).toMatchObject({
      stateBlockNumber: '0',
      stateEnrichmentStatus: 'complete',
    });
    expect(client.getTokenBalance).toHaveBeenCalledWith(address, recipient, 0n);
  });
  it('discards partial results and sanitizes historical-state exhaustion', async () => {
    const client = fixtureClient();
    vi.mocked(client.getTokenBalance)
      .mockResolvedValueOnce(amount)
      .mockRejectedValue(Error('https://secret:password@rpc.test/key'));
    const result = await new Erc20BalanceEnricher(
      enabled(),
      new RPCManager('ETHEREUM', [client], { retries: 0 }),
    ).enrich(match());
    expect(result).toEqual({
      tokenAmount: String(amount),
      isZeroAmount: 0,
      isSelfTransfer: 0,
      senderHasEnoughBalance: null,
      amountToSenderBalanceRatio: null,
      stateBlockNumber: '8',
      stateEnrichmentStatus: 'failed',
      stateEnrichmentReason: 'historical_state_unavailable',
      senderTokenBalanceBeforeBlock: null,
      recipientTokenBalanceBeforeBlock: null,
      senderBalanceEqualsAmount: null,
      recipientBalanceWasZero: null,
    });
    expect(JSON.stringify(result)).not.toMatch(/password|secret|rpc.test/);
  });
  it('never derives state from receipt outcomes or gas', async () => {
    const client = fixtureClient();
    const enricher = new Erc20BalanceEnricher(enabled(), new RPCManager('ETHEREUM', [client]));
    const m = match();
    const original = await enricher.enrich(m);
    m.receipt = receipt(m.transaction, {
      gasUsed: 17100n,
      status: 'reverted',
      logs: [{ address, topics: [] }],
    });
    expect(await enricher.enrich(m)).toEqual(original);
  });
  it('retains zero/self calldata flags after historical state failure', async () => {
    const client = fixtureClient();
    vi.mocked(client.getTokenBalance).mockRejectedValue(Error('missing state'));
    const m = match(input(other, 0n));
    m.transaction.from = `0x${other.slice(2).toUpperCase()}`;
    const result = await new Erc20BalanceEnricher(
      enabled(),
      new RPCManager('ETHEREUM', [client], { retries: 0 }),
    ).enrich(m);
    expect(result).toMatchObject({
      tokenAmount: '0',
      isSelfTransfer: 1,
      isZeroAmount: 1,
      senderHasEnoughBalance: null,
      amountToSenderBalanceRatio: null,
      stateEnrichmentStatus: 'failed',
    });
    expect(client.getTokenBalance).toHaveBeenCalledOnce();
  });
});

it.each([
  [6n, 9n, '2/3'],
  [0n, 0n, null],
  [0n, 2n, '0/1'],
] as const)(
  'encodes amount/balance as an exact reduced rational (%s/%s)',
  (value, balance, expected) => {
    expect(amountBalanceRatio(value, balance)).toBe(expected);
  },
);

describe('historical balance routing', () => {
  it('honors structured Retry-After on historical calls', async () => {
    const client = fixtureClient();
    vi.mocked(client.getTokenBalance)
      .mockRejectedValueOnce({ headers: { 'retry-after': '2' } })
      .mockResolvedValue(5n);
    let now = 0;
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    const rpc = new RPCManager('ETHEREUM', [client], { retries: 1, sleep, now: () => now });
    expect(await rpc.getTokenBalance(address, other, 8n)).toBe(5n);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(2000);
  });
  it('uses existing retries and fallback, excluding wrong-chain endpoints', async () => {
    const wrong = fixtureClient(),
      failing = fixtureClient(),
      good = fixtureClient();
    vi.mocked(wrong.getChainId).mockResolvedValue(137);
    vi.mocked(wrong.getBlockNumber).mockResolvedValue(1000n);
    vi.mocked(failing.getTokenBalance).mockRejectedValue(
      Error('missing trie node / archive unavailable'),
    );
    vi.mocked(good.getTokenBalance).mockResolvedValue(amount);
    let now = 0;
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    const rpc = new RPCManager('ETHEREUM', [wrong, failing, good], {
      retries: 2,
      sleep,
      now: () => now,
    });
    expect(await rpc.getTokenBalance(address, other, 8n)).toBe(amount);
    expect(wrong.getTokenBalance).not.toHaveBeenCalled();
    expect(failing.getTokenBalance).toHaveBeenCalledTimes(3);
    expect(good.getTokenBalance).toHaveBeenCalledWith(address, other, 8n);
    expect(sleep.mock.calls).toEqual([[250], [500]]);
  });
  it.each([-1n, 1n << 256n, null, 0, '0'])(
    'rejects invalid balance %s before accepting fallback',
    async (bad) => {
      const a = fixtureClient(),
        b = fixtureClient();
      vi.mocked(a.getTokenBalance).mockResolvedValue(bad as bigint);
      vi.mocked(b.getTokenBalance).mockResolvedValue(7n);
      expect(
        await new RPCManager('ETHEREUM', [a, b], { retries: 2 }).getTokenBalance(
          address,
          other,
          8n,
        ),
      ).toBe(7n);
      expect(a.getTokenBalance).toHaveBeenCalledOnce();
    },
  );
  it('rejects invalid reference heights before probing', async () => {
    const client = fixtureClient();
    await expect(
      new RPCManager('ETHEREUM', [client]).getTokenBalance(address, other, -1n),
    ).rejects.toThrow();
    expect(client.getChainId).not.toHaveBeenCalled();
  });
  it.each(['0x', '0x01', '0x' + '0'.repeat(65), '0x' + 'z'.repeat(64)])(
    'validates raw ABI response %s',
    async (result) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }))),
      );
      const [client] = new RpcClientFactory('ETHEREUM', 100).create(['https://fixture.invalid']);
      await expect(client.getTokenBalance(address, other, 8n)).rejects.toThrow('Invalid');
    },
  );
  it('sends exact balanceOf eth_call with numeric previous block, never latest', async () => {
    const fetch = vi.fn(async (_url: unknown, options: RequestInit) => {
      expect(JSON.parse(String(options.body))).toMatchObject({
        method: 'eth_call',
        params: [{ to: address, data: `0x70a08231${other.slice(2).padStart(64, '0')}` }, '0x8'],
      });
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: '0x' + amount.toString(16).padStart(64, '0'),
        }),
      );
    });
    vi.stubGlobal('fetch', fetch);
    const [client] = new RpcClientFactory('ETHEREUM', 1000).create(['https://fixture.invalid']);
    expect(await client.getTokenBalance(address, other, 8n)).toBe(amount);
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe('opt-in configuration', () => {
  it('defaults both settings to false', () => {
    expect(selection().erc20BalanceEnrichment).toBe(false);
    expect(selection().contracts[0].erc20).toBe(false);
  });
  it.each(['true', 1, null, [], {}])('rejects nonboolean setting %s', (value) => {
    expect(() => selection({ erc20BalanceEnrichment: value })).toThrow('configuration');
    expect(() => selection({ contracts: [{ address, erc20: value }] })).toThrow('configuration');
  });
});
