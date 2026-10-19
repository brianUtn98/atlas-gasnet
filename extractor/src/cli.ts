import { pathToFileURL } from 'node:url';
import { help, parseArguments } from './arguments.js';
import { loadConfiguration } from './config.js';
import { RPCManager, publicClients } from './rpc.js';
import { FileStore, runExtraction } from './persistence.js';

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = parseArguments(args);
  if (options.help) { console.log(help); return; }
  const { selection, urls } = await loadConfiguration(options.configPath!, options.rpcPath, process.env.INIT_CWD ?? process.cwd());
  const rpc = new RPCManager(selection.network, publicClients(selection.network, urls, selection.probeTimeoutMs), selection);
  const result = await runExtraction(selection, rpc, await FileStore.create(selection.outputDir));
  console.log(`Extraction complete: ${result.rowCount} rows in ${result.parts.length} parts.`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Extraction failed; check configuration and RPC availability. Use --help.'); process.exitCode = 1; });
}
