import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { isAddress, parseAbiItem, toFunctionSelector, toFunctionSignature } from 'viem';
import { mainnet, sepolia, avalanche, avalancheFuji, polygon, polygonAmoy } from 'viem/chains';

export const networks = {
  ETHEREUM: mainnet,
  ETHEREUM_SEPOLIA: sepolia,
  AVALANCHE: avalanche,
  AVALANCHE_FUJI: avalancheFuji,
  POLYGON: polygon,
  POLYGON_AMOY: polygonAmoy,
} as const;
export type NetworkName = keyof typeof networks;
export const outputFormats = ['parquet', 'pdf', 'json'] as const;
export type OutputFormat = (typeof outputFormats)[number];
export interface ContractSelection {
  address: string;
  erc20?: boolean;
  functions?: string[];
  eventTopics?: string[];
}
export interface Selection {
  erc20BalanceEnrichment: boolean;
  network: NetworkName;
  fromBlock: bigint;
  toBlock: bigint;
  contracts: ContractSelection[];
  outputDir: string;
  batchSize: number;
  retries: number;
  healthRefreshIntervalMs: number;
  probeTimeoutMs: number;
  outputFormats: OutputFormat[];
}
const fail = (): never => {
  throw new Error('Invalid extraction or RPC configuration.');
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
}
function boolean(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') return fail();
  return value;
}
function positive(value: unknown, fallback: number, max = 2_147_483_647, min = 1): number {
  const n = value === undefined ? fallback : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < min || n > max) return fail();
  return n;
}
function block(value: unknown): bigint {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) return fail();
    return BigInt(value);
  }
  if (
    (typeof value === 'string' && /^\d+$/.test(value)) ||
    (typeof value === 'bigint' && value >= 0n)
  )
    return BigInt(value);
  return fail();
}
function filter(value: unknown, transform: (s: string) => string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.length || value.some((v) => typeof v !== 'string'))
    return fail();
  return [...new Set((value as string[]).map(transform))].sort();
}
export function selector(value: string): string {
  if (/^0x[0-9a-fA-F]{8}$/.test(value)) return value.toLowerCase();
  // Require canonical signatures (no parameter names, aliases, or whitespace).
  if (!/^[A-Za-z_$][\w$]*\((?:[A-Za-z0-9_(),\[\]]*)\)$/.test(value) || /\b(uint|int)\b/.test(value))
    return fail();
  try {
    const item = parseAbiItem(`function ${value}`);
    if (item.type !== 'function' || toFunctionSignature(item) !== value) return fail();
    return toFunctionSelector(item);
  } catch {
    return fail();
  }
}
export function validateSelection(raw: unknown, baseDirectory = process.cwd()): Selection {
  const v = object(raw);
  if (typeof v.network !== 'string' || !Object.hasOwn(networks, v.network)) return fail();
  const fromBlock = block(v.fromBlock),
    toBlock = block(v.toBlock);
  if (fromBlock > toBlock || !Array.isArray(v.contracts) || !v.contracts.length) return fail();
  const seen = new Set<string>();
  const contracts = v.contracts
    .map((rawContract) => {
      const c = object(rawContract);
      if (typeof c.address !== 'string' || !isAddress(c.address, { strict: false })) return fail();
      const address = c.address.toLowerCase();
      if (seen.has(address)) return fail();
      seen.add(address);
      return {
        address,
        erc20: boolean(c.erc20),
        functions: filter(c.functions, selector),
        eventTopics: filter(c.eventTopics, (t) => {
          if (!/^0x[0-9a-fA-F]{64}$/.test(t)) return fail();
          return t.toLowerCase();
        }),
      };
    })
    .sort((a, b) => a.address.localeCompare(b.address));
  if (typeof v.outputDir !== 'string' || !v.outputDir.trim()) return fail();
  const formats = v.outputFormats === undefined ? [...outputFormats] : v.outputFormats;
  if (
    !Array.isArray(formats) ||
    !formats.length ||
    formats.some((format) => !outputFormats.includes(format)) ||
    new Set(formats).size !== formats.length
  )
    return fail();
  return {
    erc20BalanceEnrichment: boolean(v.erc20BalanceEnrichment),
    network: v.network as NetworkName,
    fromBlock,
    toBlock,
    contracts,
    outputDir: resolve(baseDirectory, v.outputDir),
    outputFormats: [...formats] as OutputFormat[],
    batchSize: positive(v.batchSize, 100),
    retries: positive(v.retries, 3, 10, 0),
    healthRefreshIntervalMs: positive(v.healthRefreshIntervalMs, 30_000),
    probeTimeoutMs: positive(v.probeTimeoutMs, 5_000),
  };
}
export function validateRpcs(raw: unknown, network: NetworkName): string[] {
  const urls = object(raw)[network];
  if (!Array.isArray(urls) || !urls.length) return fail();
  for (const url of urls) {
    if (typeof url !== 'string') return fail();
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) return fail();
    } catch {
      return fail();
    }
  }
  if (new Set(urls).size !== urls.length) return fail();
  return urls as string[];
}
export function parseYaml(text: string): unknown {
  try {
    const doc = parseDocument(text, { intAsBigInt: true });
    if (doc.errors.length) return fail();
    // Operational settings are bounded JS numbers; block integers retain precision.
    const value = doc.toJS({ maxAliasCount: 10 });
    if (value && typeof value === 'object')
      for (const k of ['batchSize', 'retries', 'healthRefreshIntervalMs', 'probeTimeoutMs']) {
        if (typeof value[k] === 'bigint') value[k] = Number(value[k]);
      }
    return value;
  } catch {
    return fail();
  }
}
export class ConfigurationLoader {
  constructor(private readonly baseDirectory = process.cwd()) {}

  async load(
    configPath: string,
    rpcPath: string,
  ): Promise<{ selection: Selection; urls: string[] }> {
    const baseDirectory = this.baseDirectory;
    try {
      const selection = validateSelection(
        parseYaml(await readFile(resolve(baseDirectory, configPath), 'utf8')),
        baseDirectory,
      );
      const urls = validateRpcs(
        parseYaml(await readFile(resolve(baseDirectory, rpcPath), 'utf8')),
        selection.network,
      );
      return { selection, urls };
    } catch {
      return fail();
    }
  }
}
