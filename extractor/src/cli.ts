import { failureDetails, RpcReadError } from './rpc-errors.js';
import { pathToFileURL } from 'node:url';
import { help, parseArguments } from './arguments.js';
import { ConfigurationLoader } from './config.js';
import { RPCManager, RpcClientFactory } from './rpc.js';
import { ExtractionRunner, FileStore } from './persistence.js';
import { ConsoleProgress } from './progress.js';
import { OutputManager } from './output/manager.js';

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = parseArguments(args);
  if (options.help) {
    console.log(help);
    return;
  }
  const loader = new ConfigurationLoader(process.env.INIT_CWD ?? process.cwd());
  const { selection, urls } = await loader.load(options.configPath!, options.rpcPath);
  const progress = new ConsoleProgress();
  progress.report({
    phase: 'start',
    network: selection.network,
    fromBlock: String(selection.fromBlock),
    toBlock: String(selection.toBlock),
    rpcConcurrency: selection.rpcConcurrency,
    rpcBatchSize: selection.rpcBatchSize,
    rpcAdaptiveConcurrency: selection.rpcAdaptiveConcurrency ? 'enabled' : 'disabled',
  });
  const clients = new RpcClientFactory(selection.network, selection.probeTimeoutMs, {
    ...selection,
    progress: progress.report,
  }).create(urls);
  const rpc = new RPCManager(selection.network, clients, {
    ...selection,
    progress: progress.report,
  });
  const store = await FileStore.create(selection.outputDir);
  try {
    const result = await new ExtractionRunner(
      selection,
      rpc,
      store,
      new OutputManager(),
      progress.report,
    ).run();
    console.log(
      `Extraction ${result.complete ? 'complete' : 'finished with errors'}: ${result.rowCount} rows in ${result.parts.length} parts.`,
    );
    if (result.errorCount)
      console.log(
        `Pending errors: ${result.errorCount}. See errors.json in the output directory; rerun to repair affected batches.`,
      );
    console.log(
      `Output formats: ${selection.outputFormats.join(', ')} (in the configured output directory).`,
    );
  } finally {
    progress.report({ phase: 'rpc_summary', ...rpc.metrics() });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(`Failure details: ${JSON.stringify(failureDetails(error))}`);
    console.error(
      'Extraction or report generation failed; check configuration, RPC availability, and output permissions. Use --help.',
    );
    process.exitCode = error instanceof RpcReadError && error.retryable ? 2 : 1;
  });
}
