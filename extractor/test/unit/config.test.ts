import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConfigurationLoader,
  networks,
  parseYaml,
  selector,
  validateRpcs,
  validateSelection,
} from '../../src/config.js';
const address = '0x' + 'ab'.repeat(20);
const raw = () => ({
  network: 'ETHEREUM',
  fromBlock: '0',
  toBlock: '10',
  outputDir: 'data/extractions/test',
  contracts: [{ address }],
});
describe('configuration', () => {
  it('defaults to eight concurrent RPC requests and accepts an explicit bounded limit', () => {
    expect(validateSelection(raw()).rpcConcurrency).toBe(8);
    const parsed = parseYaml(JSON.stringify({ ...raw(), rpcConcurrency: 8 }));
    expect(validateSelection(parsed).rpcConcurrency).toBe(8);
  });
  it('defaults to all three output formats and versions that choice in the repo example', async () => {
    expect(validateSelection(raw()).outputFormats).toEqual(['parquet', 'pdf', 'json']);
    const example = parseYaml(
      await readFile(new URL('../../../config/extraction.yaml', import.meta.url), 'utf8'),
    );
    expect(validateSelection(example).outputFormats).toEqual(['parquet', 'pdf', 'json']);
  });
  it.each([['json'], ['pdf'], ['parquet', 'json']].map((formats) => ({ formats })))(
    'accepts selected output formats $formats',
    ({ formats }) => {
      expect(validateSelection({ ...raw(), outputFormats: formats }).outputFormats).toEqual(
        formats,
      );
    },
  );
  it.each(
    [[], ['csv'], ['JSON'], ['json', 'json'], 'json', null, [1]].map((formats) => ({ formats })),
  )('rejects invalid output formats $formats', ({ formats }) => {
    expect(() => validateSelection({ ...raw(), outputFormats: formats })).toThrow();
  });
  it('maps all six networks', () =>
    expect(Object.values(networks).map((n) => n.id)).toEqual([
      1, 11155111, 43114, 43113, 137, 80002,
    ]));
  it.each(Object.keys(networks))('accepts %s', (network) =>
    expect(validateSelection({ ...raw(), network }).network).toBe(network),
  );
  it('accepts one/many URLs and multiple normalized recipients', () => {
    expect(validateRpcs({ ETHEREUM: ['https://a.test'] }, 'ETHEREUM')).toHaveLength(1);
    expect(
      validateRpcs({ ETHEREUM: ['http://a.test', 'https://b.test'] }, 'ETHEREUM'),
    ).toHaveLength(2);
    expect(
      validateSelection({ ...raw(), contracts: [{ address }, { address: '0x' + 'cd'.repeat(20) }] })
        .contracts,
    ).toHaveLength(2);
  });
  it.each([
    {},
    { ETHEREUM: [] },
    { ETHEREUM: 'https://a.test' },
    { ETHEREUM: ['ws://a.test'] },
    { ETHEREUM: ['broken'] },
    { ETHEREUM: [1] },
    { ETHEREUM: ['https://a.test', 'https://a.test'] },
  ])('rejects invalid endpoints safely', (endpoints) =>
    expect(() => validateRpcs(endpoints, 'ETHEREUM')).toThrow(
      'Invalid extraction or RPC configuration.',
    ),
  );
  it.each([
    { network: 'ethereum' },
    { network: 'UNSUPPORTED' },
    { fromBlock: '-1' },
    { fromBlock: '11' },
    { toBlock: 1.5 },
    { fromBlock: 2 ** 53 },
    { batchSize: 0 },
    { rpcConcurrency: 0 },
    { rpcConcurrency: 33 },
    { rpcConcurrency: 1.5 },
    { rpcConcurrency: '4' },
    { retries: 11 },
    { healthRefreshIntervalMs: 0 },
    { probeTimeoutMs: -1 },
    { probeTimeoutMs: '5000' },
    { contracts: [] },
    { contracts: [{ address: 'invalid' }] },
    { contracts: [{ address }, { address: address.toUpperCase().replace('0X', '0x') }] },
  ])('rejects invalid selections %j', (patch) =>
    expect(() => validateSelection({ ...raw(), ...patch })).toThrow(),
  );
  it('preserves huge blocks and omitted filters', () => {
    const parsed = parseYaml(
      'network: ETHEREUM\nfromBlock: 9007199254740993\ntoBlock: 9007199254740994\noutputDir: data\ncontracts:\n - address: "' +
        address +
        '"',
    );
    expect(validateSelection(parsed).fromBlock).toBe(9007199254740993n);
    expect(validateSelection(raw()).contracts[0].functions).toBeUndefined();
  });
  it.each([
    { functions: [] },
    { eventTopics: [] },
    { functions: ['transfer'] },
    { functions: ['transfer(address,uint)'] },
    { functions: ['x(bad_type)'] },
    { eventTopics: ['0x1234'] },
  ])('rejects empty/malformed filters', (filter) =>
    expect(() => validateSelection({ ...raw(), contracts: [{ address, ...filter }] })).toThrow(),
  );
  it('normalizes selectors/topics with deduplication', () => {
    expect(selector('transfer(address,uint256)')).toBe('0xa9059cbb');
    expect(
      validateSelection({
        ...raw(),
        contracts: [
          {
            address,
            functions: ['transfer(address,uint256)', '0xA9059CBB'],
            eventTopics: ['0x' + 'AB'.repeat(32)],
          },
        ],
      }).contracts[0],
    ).toEqual({
      address,
      erc20: false,
      functions: ['0xa9059cbb'],
      eventTopics: ['0x' + 'ab'.repeat(32)],
    });
  });
  it.each(['x: [', 'x: 1\nx: 2', 'x: *missing'])('rejects malformed YAML', (yaml) =>
    expect(() => parseYaml(yaml)).toThrow(),
  );
  it('replaces rather than merges explicit RPC maps', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atlas-config-'));
    try {
      const config = join(dir, 'selection.yaml'),
        rpc = join(dir, 'custom.yaml');
      await writeFile(config, JSON.stringify(raw()));
      await writeFile(rpc, 'ETHEREUM:\n - https://custom.test\n');
      expect((await new ConfigurationLoader().load(config, rpc)).urls).toEqual([
        'https://custom.test',
      ]);
      await writeFile(rpc, 'POLYGON:\n - https://custom.test\n');
      await expect(new ConfigurationLoader().load(config, rpc)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
