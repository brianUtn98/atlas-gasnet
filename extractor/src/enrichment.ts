import type { Selection } from './config.js';
import type { Match } from './extract.js';
import { assertData, type ReadonlyRPC } from './rpc.js';

export const statePolicy = {
  failurePolicy: 'record_null_and_continue',
  reference: 'end_of_previous_block',
  ratioEncoding: 'reduced_unsigned_rational_string',
  ratioZeroDenominator: 'null',
  limitation:
    'Prior-block state approximates pre-transaction state; earlier same-block operations may change balances.',
} as const;

export interface BalanceState {
  tokenAmount: string | null;
  isZeroAmount: number | null;
  isSelfTransfer: number | null;
  senderHasEnoughBalance: number | null;
  amountToSenderBalanceRatio: string | null;
  stateBlockNumber: string | null;
  senderTokenBalanceBeforeBlock: string | null;
  recipientTokenBalanceBeforeBlock: string | null;
  recipientBalanceWasZero: number | null;
  senderBalanceEqualsAmount: number | null;
  stateEnrichmentStatus: 'not_applicable' | 'failed' | 'complete';
  stateEnrichmentReason:
    | 'disabled'
    | 'contract_not_enabled'
    | 'other_function'
    | 'invalid_calldata'
    | 'invalid_state_block'
    | 'historical_state_unavailable'
    | null;
}

export function emptyBalanceState(
  reason: BalanceState['stateEnrichmentReason'] = 'disabled',
): BalanceState {
  return {
    tokenAmount: null,
    isZeroAmount: null,
    isSelfTransfer: null,
    senderHasEnoughBalance: null,
    amountToSenderBalanceRatio: null,
    stateBlockNumber: null,
    senderTokenBalanceBeforeBlock: null,
    recipientTokenBalanceBeforeBlock: null,
    recipientBalanceWasZero: null,
    senderBalanceEqualsAmount: null,
    stateEnrichmentStatus: 'not_applicable',
    stateEnrichmentReason: reason,
  };
}

/** Strict static ABI decoding. tx.to remains the token contract, not this recipient. */
export function decodeTransfer(input: string): { recipient: string; amount: bigint } | null {
  if (!/^0xa9059cbb0{24}[0-9a-f]{40}[0-9a-f]{64}$/i.test(input)) return null;
  return {
    recipient: `0x${input.slice(34, 74).toLowerCase()}`,
    amount: BigInt(`0x${input.slice(74)}`),
  };
}

/** Exact quotient: no float conversion, precision cap or artificial infinity. */
export function amountBalanceRatio(amount: bigint, balance: bigint): string | null {
  if (balance === 0n) return null;
  let a = amount;
  let b = balance;
  while (b !== 0n) [a, b] = [b, a % b];
  return `${amount / a}/${balance / a}`;
}

export class Erc20BalanceEnricher {
  private readonly balances = new Map<string, { value: Promise<bigint>; settled: boolean }>();
  private hits = 0;
  private misses = 0;

  constructor(
    private readonly selection: Selection,
    private readonly rpc: ReadonlyRPC,
  ) {}

  metrics() {
    return {
      balanceCacheHits: this.hits,
      balanceCacheMisses: this.misses,
      balanceCacheEntries: this.balances.size,
    };
  }

  private balance(
    contract: string,
    owner: string,
    height: bigint,
    inclusionHash: string,
  ): Promise<bigint> {
    const key = [
      this.selection.network,
      contract.toLowerCase(),
      owner.toLowerCase(),
      height,
      inclusionHash.toLowerCase(),
    ].join(':');
    const previous = this.balances.get(key);
    if (previous) {
      this.hits++;
      this.balances.delete(key);
      this.balances.set(key, previous);
      return previous.value;
    }
    this.misses++;
    const capacity = this.selection.rpcBalanceCacheSize;
    if (capacity > 0 && this.balances.size >= capacity) {
      const oldest = [...this.balances].find(([, entry]) => entry.settled);
      if (oldest) this.balances.delete(oldest[0]);
    }
    const entry = {
      value: Promise.resolve().then(async () => {
        const value = await this.rpc.getTokenBalance(contract, owner, height);
        assertData(typeof value === 'bigint' && value >= 0n && value < 1n << 256n);
        return value;
      }),
      settled: false,
    };
    if (this.balances.size < capacity) this.balances.set(key, entry);
    // Never retain failed promises. In-flight entries are not evicted for capacity.
    void entry.value.then(
      () => {
        entry.settled = true;
      },
      () => {
        if (this.balances.get(key) === entry) this.balances.delete(key);
      },
    );
    return entry.value;
  }

  async enrich({ transaction: tx, block }: Match): Promise<BalanceState> {
    if (!this.selection.erc20BalanceEnrichment) return emptyBalanceState();
    if (!this.selection.contracts.some((c) => c.erc20 && c.address === tx.to?.toLowerCase()))
      return emptyBalanceState('contract_not_enabled');
    if (tx.input.slice(0, 10).toLowerCase() !== '0xa9059cbb')
      return emptyBalanceState('other_function');
    const decoded = decodeTransfer(tx.input);
    const calldata = decoded
      ? {
          tokenAmount: String(decoded.amount),
          isZeroAmount: decoded.amount === 0n ? 1 : 0,
          isSelfTransfer: decoded.recipient === tx.from.toLowerCase() ? 1 : 0,
        }
      : {};
    const failed = (
      reason: BalanceState['stateEnrichmentReason'],
      stateBlockNumber: string | null = null,
    ): BalanceState => ({
      ...emptyBalanceState(reason),
      ...calldata,
      stateEnrichmentStatus: 'failed',
      stateBlockNumber,
    });
    if (!decoded) return failed('invalid_calldata');
    if (block.number <= 0n) return failed('invalid_state_block');
    const height = block.number - 1n;
    try {
      const senderRead = this.balance(tx.to!, tx.from.toLowerCase(), height, block.hash);
      const balances = await Promise.allSettled([
        senderRead,
        decoded.recipient === tx.from.toLowerCase()
          ? senderRead
          : this.balance(tx.to!, decoded.recipient, height, block.hash),
      ]);
      const [sender, recipient] = balances.map((result) => {
        if (result.status === 'rejected') throw result.reason;
        return result.value;
      });
      assertData(typeof sender === 'bigint' && sender >= 0n && sender < 1n << 256n);
      assertData(typeof recipient === 'bigint' && recipient >= 0n && recipient < 1n << 256n);
      return {
        tokenAmount: String(decoded.amount),
        isZeroAmount: decoded.amount === 0n ? 1 : 0,
        isSelfTransfer: decoded.recipient === tx.from.toLowerCase() ? 1 : 0,
        senderHasEnoughBalance: sender >= decoded.amount ? 1 : 0,
        amountToSenderBalanceRatio: amountBalanceRatio(decoded.amount, sender),
        stateBlockNumber: String(height),
        senderTokenBalanceBeforeBlock: String(sender),
        recipientTokenBalanceBeforeBlock: String(recipient),
        recipientBalanceWasZero: recipient === 0n ? 1 : 0,
        senderBalanceEqualsAmount: sender === decoded.amount ? 1 : 0,
        stateEnrichmentStatus: 'complete',
        stateEnrichmentReason: null,
      };
    } catch {
      return failed('historical_state_unavailable', String(height));
    }
  }
}
