import { vi } from 'vitest';
import { validateSelection } from '../src/config.js';
import type { ReadClient, RpcBlock, RpcReceipt, RpcTransaction } from '../src/rpc.js';
export const address = '0x' + 'ab'.repeat(20),
  other = '0x' + 'cd'.repeat(20);
export const hash = (n: number) => '0x' + n.toString(16).padStart(64, '0');
export const selection = (patch = {}) =>
  validateSelection({
    network: 'ETHEREUM',
    fromBlock: '9',
    toBlock: '10',
    contracts: [{ address }],
    outputDir: 'data/extractions/test',
    ...patch,
  });
export function tx(height = 9n, patch: Partial<RpcTransaction> = {}): RpcTransaction {
  return {
    hash: hash(Number(height) * 100),
    blockHash: hash(Number(height)),
    blockNumber: height,
    transactionIndex: 0,
    from: other,
    to: address,
    type: 'legacy',
    nonce: 1,
    value: 0n,
    gas: 100000n,
    gasPrice: 10n,
    input: '0xa9059cbb00ff',
    ...patch,
  };
}
export function block(height = 9n, transactions = [tx(height)]): RpcBlock {
  return {
    number: height,
    hash: hash(Number(height)),
    timestamp: 1700000000n + height,
    transactions,
  };
}
export function receipt(transaction = tx(), patch: Partial<RpcReceipt> = {}): RpcReceipt {
  return {
    transactionHash: transaction.hash,
    blockHash: transaction.blockHash,
    blockNumber: transaction.blockNumber,
    transactionIndex: transaction.transactionIndex,
    from: transaction.from,
    to: transaction.to,
    gasUsed: 25000n,
    status: 'success',
    logs: [],
    ...patch,
  };
}
export function fixtureClient(): ReadClient {
  return {
    getChainId: vi.fn(async () => 1),
    getBlockNumber: vi.fn(async () => 100n),
    getBlock: vi.fn(async (h) => block(h)),
    getReceipt: vi.fn(async (h) => {
      const height = BigInt(parseInt(h.slice(2), 16) / 100);
      return receipt(tx(height));
    }),
  };
}
