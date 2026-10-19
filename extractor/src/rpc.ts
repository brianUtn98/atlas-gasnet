import { createPublicClient, http, numberToHex, type Hex } from 'viem';
import { networks, type NetworkName } from './config.js';

export interface RpcTransaction {
  hash: string; blockHash: string; blockNumber: bigint; transactionIndex: number | bigint;
  from: string; to: string | null; type: string; nonce: number | bigint; value: bigint; gas: bigint;
  input: string; gasPrice?: bigint | null; maxFeePerGas?: bigint | null; maxPriorityFeePerGas?: bigint | null;
  accessList?: { address: string; storageKeys: string[] }[];
}
export interface RpcBlock { number: bigint; hash: string; timestamp: bigint; transactions: RpcTransaction[] }
export interface RpcReceipt {
  transactionHash: string; blockHash: string; blockNumber: bigint; transactionIndex: number | bigint;
  from: string; to: string | null; gasUsed: bigint; status: 'success' | 'reverted';
  logs: { address: string; topics: string[] }[];
}
export interface ReadClient {
  getChainId(): Promise<number>;
  getBlockNumber(): Promise<bigint>;
  getBlock(height: bigint): Promise<RpcBlock>;
  getReceipt(hash: string): Promise<RpcReceipt>;
}
export interface Observation { index: number; head: bigint | null; checkedAt: number; healthy: boolean; cooldownUntil: number }
export interface ReadonlyRPC {
  getBlock(height: bigint, validate?: (block: RpcBlock) => void): Promise<RpcBlock>;
  getReceipt(hash: string, height: bigint, validate: (receipt: RpcReceipt) => void): Promise<RpcReceipt>;
}
export class InvalidData extends Error { constructor() { super('Invalid or inconsistent RPC response.'); } }
export function assertData(condition: unknown): asserts condition { if (!condition) throw new InvalidData(); }
export function validHash(value: unknown): value is string { return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value); }
export function validateBlock(block: RpcBlock, height: bigint): void {
  assertData(block && block.number === height && validHash(block.hash) && typeof block.timestamp === 'bigint' && block.timestamp >= 0n && Array.isArray(block.transactions));
}
export function publicClients(network: NetworkName, urls: string[], timeout: number): ReadClient[] {
  const exact = (value: unknown): bigint => { assertData(typeof value==='string' && /^0x[0-9a-fA-F]+$/.test(value as string));return BigInt(value as string); };
  return urls.map(url => {
    const client = createPublicClient({ chain: networks[network], transport: http(url, { retryCount: 0, timeout }) });
    return {
      getChainId: () => client.getChainId(), getBlockNumber: () => client.getBlockNumber({ cacheTime: 0 }),
      getBlock: async height => {
        // Read raw quantities through viem so nonce never passes through a JS
        // number (viem's convenience formatter uses number for nonce/index).
        const raw=await client.request({method:'eth_getBlockByNumber',params:[numberToHex(height),true]});
        try {
          assertData(raw && Array.isArray(raw.transactions));
          return {number:exact(raw.number),hash:raw.hash!,timestamp:exact(raw.timestamp),transactions:raw.transactions.map(tx=>{
            assertData(tx && typeof tx==='object');if(typeof tx==='string')throw new InvalidData();
            return {...tx,blockNumber:exact(tx.blockNumber),transactionIndex:exact(tx.transactionIndex),nonce:exact(tx.nonce),value:exact(tx.value),gas:exact(tx.gas),
              gasPrice:tx.gasPrice==null?undefined:exact(tx.gasPrice),maxFeePerGas:tx.maxFeePerGas==null?undefined:exact(tx.maxFeePerGas),maxPriorityFeePerGas:tx.maxPriorityFeePerGas==null?undefined:exact(tx.maxPriorityFeePerGas)};
          })} as RpcBlock;
        } catch {throw new InvalidData();}
      },
      getReceipt: async hash => {
        const raw=await client.request({method:'eth_getTransactionReceipt',params:[hash as Hex]});
        try {
          assertData(raw && (raw.status==='0x0'||raw.status==='0x1'));
          return {...raw,blockNumber:exact(raw.blockNumber),transactionIndex:exact(raw.transactionIndex),gasUsed:exact(raw.gasUsed),status:raw.status==='0x1'?'success':'reverted'} as RpcReceipt;
        } catch {throw new InvalidData();}
      },
    };
  });
}
interface ManagerOptions { retries?: number; healthRefreshIntervalMs?: number; probeTimeoutMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> }
function retryAfter(error: unknown, now: number): number {
  // Inspect structured metadata only. Never surface external error messages or URLs.
  let e = error as { cause?: unknown; headers?: { get?: (key: string) => string | null; 'retry-after'?: string }; retryAfter?: string } | undefined;
  for (let depth = 0; e && depth < 5; depth++, e = e.cause as typeof e) {
    const raw = e.retryAfter ?? e.headers?.get?.('retry-after') ?? e.headers?.['retry-after'];
    if (raw !== undefined && raw !== null) {
      const ms = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - now;
      if (Number.isFinite(ms)) return Math.max(0, Math.min(30_000, ms));
    }
  }
  return 0;
}
export class RPCManager implements ReadonlyRPC {
  private readonly observations: Observation[];
  private lastRefresh = -Infinity;
  private refreshing?: Promise<void>;
  private readonly retries: number;
  private readonly interval: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  constructor(private readonly network: NetworkName, private readonly clients: ReadClient[], options: ManagerOptions = {}) {
    this.retries = options.retries ?? 3; this.interval = options.healthRefreshIntervalMs ?? 30_000;
    this.timeoutMs = options.probeTimeoutMs ?? 5_000; this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    if (!clients.length || !Number.isInteger(this.retries) || this.retries < 0 || this.retries > 10 || !Number.isInteger(this.interval) || this.interval <= 0 || !Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0) throw new Error('Invalid RPC manager settings.');
    this.observations = clients.map((_, index) => ({ index, head: null, checkedAt: -Infinity, healthy: false, cooldownUntil: 0 }));
  }
  snapshot(): Observation[] { return this.observations.map(o => ({ ...o })); }
  private async bounded<T>(work: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([Promise.resolve().then(work), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('RPC timeout.')), this.timeoutMs); })]); }
    finally { clearTimeout(timer); }
  }
  async refresh(force = false): Promise<void> {
    if (this.refreshing) return this.refreshing;
    if (!force && this.now() - this.lastRefresh < this.interval) return;
    this.refreshing = (async () => {
      // Bound probe concurrency without a background monitoring service.
      for (let start = 0; start < this.clients.length; start += 4) await Promise.all(this.clients.slice(start, start + 4).map(async (client, offset) => {
        const o = this.observations[start + offset];
        if (this.now() < o.cooldownUntil) { o.healthy = false; return; }
        try {
          const head = await this.bounded(async () => {
            const chainId = await client.getChainId(); assertData(chainId === networks[this.network].id);
            const value = await client.getBlockNumber(); assertData(typeof value === 'bigint' && value >= 0n); return value;
          });
          Object.assign(o, { head, checkedAt: this.now(), healthy: true, cooldownUntil: 0 });
        } catch (error) { o.healthy = false; o.checkedAt = this.now(); o.cooldownUntil = this.now() + retryAfter(error, this.now()); }
      }));
      this.lastRefresh = this.now();
    })();
    try { await this.refreshing; } finally { this.refreshing = undefined; }
  }
  private async read<T>(height: bigint, operation: (client: ReadClient) => Promise<T>, validate: (value: T) => void): Promise<T> {
    const rejected = new Set<number>();
    for (let round = 0; round <= this.retries; round++) {
      await this.refresh(round > 0);
      const ranked = this.observations.filter(o => o.healthy && this.now() - o.checkedAt < this.interval && o.head !== null && o.head >= height && !rejected.has(o.index))
        .sort((a, b) => a.head === b.head ? a.index - b.index : a.head! > b.head! ? -1 : 1);
      for (const o of ranked) {
        // Probes/other reads may change state while this read is in flight.
        if (this.now() - o.checkedAt >= this.interval) break;
        rejected.add(o.index);
        for (let attempt = 0; attempt <= this.retries; attempt++) {
          try {
            const value = await this.bounded(() => operation(this.clients[o.index]));
            try { validate(value); } catch { throw new InvalidData(); }
            o.healthy = true; o.cooldownUntil = 0;
            return value;
          } catch (error) {
            o.healthy = false;
            if (error instanceof InvalidData) break;
            const delay = Math.max(Math.min(250 * 2 ** attempt, 30_000), retryAfter(error, this.now()));
            o.cooldownUntil = this.now() + delay;
            if (attempt === this.retries) break;
            await this.sleep(delay);
          }
        }
      }
      if (rejected.size === this.clients.length) break;
      if (round < this.retries) await this.sleep(Math.min(250 * 2 ** round, 30_000));
    }
    throw new Error(`RPC reads exhausted for ${this.network}; no progress committed.`);
  }
  getBlock(height: bigint, validate: (block: RpcBlock) => void = () => {}): Promise<RpcBlock> {
    return this.read(height, c => c.getBlock(height), b => { validateBlock(b, height); validate(b); });
  }
  getReceipt(hash: string, height: bigint, validate: (receipt: RpcReceipt) => void): Promise<RpcReceipt> {
    return this.read(height, c => c.getReceipt(hash), r => { assertData(r && r.transactionHash?.toLowerCase() === hash.toLowerCase() && r.blockNumber === height && validHash(r.blockHash)); validate(r); });
  }
}
