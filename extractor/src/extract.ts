import type { ContractSelection, Selection } from './config.js';
import { ConcurrencyLimiter, mapConcurrent } from './concurrency.js';
import { RpcReadError, failureDetails, rpcFailure } from './rpc-errors.js';
import type { ExtractionIssue } from './state.js';
import {
  assertData,
  InvalidData,
  validHash,
  validateBlock,
  type ReadonlyRPC,
  type RpcBlock,
  type RpcReceipt,
  type RpcTransaction,
} from './rpc.js';

export const addressValid = (v: unknown): v is string =>
  typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
export function quantity(v: unknown): string {
  assertData(
    (typeof v === 'bigint' && v >= 0n) ||
      (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0),
  );
  return String(v);
}
const equalHex = (a: string | null, b: string | null) => a?.toLowerCase() === b?.toLowerCase();
const typeCodes: Record<string, number> = {
  legacy: 0,
  eip2930: 1,
  eip1559: 2,
  eip4844: 3,
  eip7702: 4,
};
export function transactionType(type: string): number {
  const value =
    (Object.hasOwn(typeCodes, type) ? typeCodes[type] : undefined) ??
    (/^0x[0-9a-fA-F]{1,2}$/.test(type) ? Number(BigInt(type)) : undefined);
  assertData(value !== undefined);
  return value!;
}
export function validateTransaction(tx: RpcTransaction, block: RpcBlock, index: number): void {
  assertData(
    tx &&
      validHash(tx.hash) &&
      validHash(tx.blockHash) &&
      equalHex(tx.blockHash, block.hash) &&
      tx.blockNumber === block.number,
  );
  assertData(
    quantity(tx.transactionIndex) === String(index) &&
      addressValid(tx.from) &&
      (tx.to === null || addressValid(tx.to)),
  );
  quantity(tx.nonce);
  quantity(tx.value);
  quantity(tx.gas);
  assertData(
    typeof tx.input === 'string' &&
      /^0x(?:[0-9a-fA-F]{2})*$/.test(tx.input) &&
      typeof tx.type === 'string',
  );
  if (transactionType(tx.type) >= 2) {
    quantity(tx.maxFeePerGas);
    quantity(tx.maxPriorityFeePerGas);
  } else quantity(tx.gasPrice);
  if (tx.accessList !== undefined) {
    assertData(Array.isArray(tx.accessList));
    for (const entry of tx.accessList)
      assertData(
        entry &&
          addressValid(entry.address) &&
          Array.isArray(entry.storageKeys) &&
          entry.storageKeys.every(validHash),
      );
  }
}
export function validateFullBlock(block: RpcBlock, height: bigint): void {
  validateBlock(block, height);
  const seen = new Set<string>();
  block.transactions.forEach((tx, i) => {
    validateTransaction(tx, block, i);
    assertData(!seen.has(tx.hash.toLowerCase()));
    seen.add(tx.hash.toLowerCase());
  });
}
export function validateReceipt(receipt: RpcReceipt, tx: RpcTransaction, block: RpcBlock): void {
  assertData(
    receipt &&
      validHash(receipt.transactionHash) &&
      equalHex(receipt.transactionHash, tx.hash) &&
      equalHex(receipt.blockHash, block.hash) &&
      receipt.blockNumber === block.number,
    'receipt_identity',
  );
  assertData(
    quantity(receipt.transactionIndex) === quantity(tx.transactionIndex) &&
      equalHex(receipt.from, tx.from) &&
      equalHex(receipt.to, tx.to),
    'receipt_transaction_fields',
  );
  quantity(receipt.gasUsed);
  assertData(
    ['success', 'reverted'].includes(receipt.status) && Array.isArray(receipt.logs),
    'receipt_status_or_logs',
  );
  for (const log of receipt.logs)
    assertData(
      log && addressValid(log.address) && Array.isArray(log.topics) && log.topics.every(validHash),
      'receipt_log',
    );
}
export interface Match {
  block: RpcBlock;
  transaction: RpcTransaction;
  receipt: RpcReceipt;
}
export class TransactionScanner {
  private readonly contracts: Map<string, ContractSelection>;
  private readonly transactionWorkers: ConcurrencyLimiter;

  constructor(
    private readonly rpc: ReadonlyRPC,
    private readonly selection: Selection,
    private readonly progress: (blocks: number, receipts: number) => void = () => {},
    private readonly onError?: (issue: ExtractionIssue) => Promise<void>,
    private readonly anchors = new Map<string, string>(),
  ) {
    this.contracts = new Map(selection.contracts.map((contract) => [contract.address, contract]));
    this.transactionWorkers = new ConcurrencyLimiter(selection.rpcConcurrency);
  }

  async scan(
    from = this.selection.fromBlock,
    to = this.selection.toBlock,
    onMatch?: (match: Match) => Promise<void>,
  ): Promise<{ matches: Match[]; lastBlock: RpcBlock | null }> {
    const { rpc, selection, contracts } = this;
    if (from > to || from < selection.fromBlock || to > selection.toBlock)
      throw new Error('Invalid batch range.');
    const heights: bigint[] = [];
    for (let height = from; height <= to; height++) heights.push(height);
    let blocksRead = 0;
    let receiptsRead = 0;
    const batches = await mapConcurrent(heights, selection.rpcConcurrency, async (height) => {
      let block: RpcBlock;
      try {
        block = await rpc.getBlock(height, (b) => validateFullBlock(b, height));
        validateFullBlock(block, height);
      } catch (error) {
        await this.record(error, height, 'block');
        this.progress(++blocksRead, receiptsRead);
        return { block: null, matches: [] as Match[] };
      }
      const anchor = this.anchors.get(String(height));
      if (anchor && block.hash.toLowerCase() !== anchor.toLowerCase())
        throw new Error('Previously committed block hash changed; recovery stopped.');
      this.progress(++blocksRead, receiptsRead);
      const selected = block.transactions.filter((tx) => {
        const contract = tx.to ? contracts.get(tx.to.toLowerCase()) : undefined;
        return (
          contract &&
          (!contract.functions ||
            (tx.input.length >= 10 &&
              contract.functions.includes(tx.input.slice(0, 10).toLowerCase())))
        );
      });
      const matches = await mapConcurrent(selected, selection.rpcConcurrency, async (tx) => {
        const release = await this.transactionWorkers.acquire();
        try {
          const contract = contracts.get(tx.to!.toLowerCase())!;
          let receipt: RpcReceipt;
          try {
            receipt = await rpc.getReceipt(tx.hash, height, (r) => validateReceipt(r, tx, block));
            validateReceipt(receipt, tx, block);
          } catch (error) {
            await this.record(error, height, 'receipt', tx.hash, block.hash);
            return undefined;
          }
          this.progress(blocksRead, ++receiptsRead);
          if (
            contract.eventTopics &&
            !receipt.logs.some(
              (log) =>
                equalHex(log.address, contract.address) &&
                contract.eventTopics!.includes(log.topics[0]?.toLowerCase()),
            )
          )
            return undefined;
          const match = { block, transaction: tx, receipt };
          await onMatch?.(match);
          return match;
        } finally {
          release();
        }
      });
      return { block, matches: matches.filter((match): match is Match => match !== undefined) };
    });
    return {
      matches: batches.flatMap((batch) => batch.matches),
      lastBlock: [...batches].reverse().find((batch) => batch.block !== null)?.block ?? null,
    };
  }

  private async record(
    error: unknown,
    height: bigint,
    operation: 'block' | 'receipt',
    transactionHash?: string,
    blockHash?: string,
  ): Promise<void> {
    if (
      !this.onError ||
      !(error instanceof InvalidData || (error instanceof RpcReadError && error.retryable))
    )
      throw error;
    await this.onError({
      operation,
      blockNumber: String(height),
      ...(transactionHash ? { transactionHash } : {}),
      ...(blockHash ? { blockHash } : {}),
      occurredAt: new Date().toISOString(),
      details: error instanceof InvalidData ? rpcFailure(error) : failureDetails(error),
    });
  }
}
