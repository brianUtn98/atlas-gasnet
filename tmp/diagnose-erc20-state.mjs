import { readFile, writeFile } from 'node:fs/promises';
import { validateSelection, parseYaml } from '../extractor/dist/config.js';
import { RpcClientFactory, RPCManager } from '../extractor/dist/rpc.js';
import { decodeTransfer, Erc20BalanceEnricher } from '../extractor/dist/enrichment.js';

const rows = JSON.parse(await readFile('data/extractions/usdc-example-v3/transactions.json', 'utf8'));
const manifest = JSON.parse(await readFile('data/extractions/usdc-example-v3/manifest.json', 'utf8'));
const rawSelection = parseYaml(await readFile('config/extraction.yaml', 'utf8'));
const mapping = parseYaml(await readFile('config/rpcs.public.yaml', 'utf8'));
const sample = rows[0];
console.log(JSON.stringify({
  datasetRows: rows.length,
  manifestEnabled: manifest.stateEnrichment.enabled,
  selectionEnabled: manifest.selection.erc20BalanceEnrichment,
  statusCounts: rows.reduce((counts, row) => {
    const key = `${row.stateEnrichmentStatus}:${row.stateEnrichmentReason}`;
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {}),
  decoded: { ...decodeTransfer(sample.input), amount: String(decodeTransfer(sample.input).amount) },
  inclusionBlock: sample.blockNumber,
  requiredStateBlock: String(BigInt(sample.blockNumber) - 1n),
}));
const selection = validateSelection({ ...rawSelection, erc20BalanceEnrichment: true, retries: 0, probeTimeoutMs: 8000 });
const factory = new RpcClientFactory(selection.network, selection.probeTimeoutMs);
for (const [index, endpoint] of mapping[selection.network].entries()) {
  const rpc = new RPCManager(selection.network, factory.create([endpoint]), selection);
  const result = await new Erc20BalanceEnricher(selection, rpc).enrich({
    transaction: { from: sample.from, to: sample.to, input: sample.input },
    block: { number: BigInt(sample.blockNumber) },
  });
  console.log(JSON.stringify({ endpointIndex: index, observations: rpc.snapshot().map(({ index, head, healthy }) => ({ index, head: head === null ? null : String(head), healthy })), enrichment: result }));
}
const rpc = new RPCManager(selection.network, factory.create(mapping[selection.network]), selection);
const enricher = new Erc20BalanceEnricher(selection, rpc);
const enriched = [];
for (const row of rows) {
  enriched.push({ ...row, ...await enricher.enrich({
    transaction: { from: row.from, to: row.to, input: row.input },
    block: { number: BigInt(row.blockNumber) },
  }) });
}
await writeFile('tmp/usdc-enriched-preview.json', JSON.stringify(enriched, null, 2) + '\n');
console.log(JSON.stringify({
  preview: 'tmp/usdc-enriched-preview.json',
  rows: enriched.length,
  statuses: enriched.reduce((counts, row) => {
    counts[row.stateEnrichmentStatus] = (counts[row.stateEnrichmentStatus] ?? 0) + 1;
    return counts;
  }, {}),
  gasUsedUnchanged: enriched.every((row, index) => row.gasUsed === rows[index].gasUsed),
  references: [...new Set(enriched.map((row) => row.stateBlockNumber))],
}));
