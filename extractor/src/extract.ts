import type { ContractSelection, Selection } from './config.js';
import {
  assertData,
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
  );
  assertData(
    quantity(receipt.transactionIndex) === quantity(tx.transactionIndex) &&
      equalHex(receipt.from, tx.from) &&
      equalHex(receipt.to, tx.to),
  );
  quantity(receipt.gasUsed);
  assertData(['success', 'reverted'].includes(receipt.status) && Array.isArray(receipt.logs));
  for (const log of receipt.logs)
    assertData(
      log && addressValid(log.address) && Array.isArray(log.topics) && log.topics.every(validHash),
    );
}
export interface Match {
  block: RpcBlock;
  transaction: RpcTransaction;
  receipt: RpcReceipt;
}
export class TransactionScanner {
  private readonly contracts: Map<string, ContractSelection>;

  constructor(
    private readonly rpc: ReadonlyRPC,
    private readonly selection: Selection,
  ) {
    this.contracts = new Map(selection.contracts.map((contract) => [contract.address, contract]));
  }

  async scan(
    from = this.selection.fromBlock,
    to = this.selection.toBlock,
  ): Promise<{ matches: Match[]; lastBlock: RpcBlock }> {
    const { rpc, selection, contracts } = this;
    if (from > to || from < selection.fromBlock || to > selection.toBlock)
      throw new Error('Invalid batch range.');
    const matches: Match[] = [];
    let lastBlock!: RpcBlock;
    for (let height = from; height <= to; height++) {
      const block = await rpc.getBlock(height, (b) => validateFullBlock(b, height));
      validateFullBlock(block, height);
      for (const tx of block.transactions) {
        const contract = tx.to ? contracts.get(tx.to.toLowerCase()) : undefined;
        if (
          !contract ||
          (contract.functions &&
            (tx.input.length < 10 ||
              !contract.functions.includes(tx.input.slice(0, 10).toLowerCase())))
        )
          continue;
        const receipt = await rpc.getReceipt(tx.hash, height, (r) => validateReceipt(r, tx, block));
        validateReceipt(receipt, tx, block);
        if (
          contract.eventTopics &&
          !receipt.logs.some(
            (log) =>
              equalHex(log.address, contract.address) &&
              contract.eventTopics!.includes(log.topics[0]?.toLowerCase()),
          )
        )
          continue;
        matches.push({ block, transaction: tx, receipt });
      }
      lastBlock = block;
    }
    return { matches, lastBlock };
  }
}
