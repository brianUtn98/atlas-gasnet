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
  constructor(
    private readonly selection: Selection,
    private readonly rpc: ReadonlyRPC,
  ) {}

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
      const sender = await this.rpc.getTokenBalance(tx.to!, tx.from.toLowerCase(), height);
      const recipient =
        decoded.recipient === tx.from.toLowerCase()
          ? sender
          : await this.rpc.getTokenBalance(tx.to!, decoded.recipient, height);
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
