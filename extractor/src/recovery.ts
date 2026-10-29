import type { Selection } from './config.js';
import type { ProgressReporter } from './progress.js';
import { RpcReadError } from './rpc-errors.js';

/** Retry only exhausted RPC reads. Commit/output/configuration errors must propagate. */
export async function recoverRpc<T>(
  operation: () => Promise<T>,
  selection: Pick<Selection, 'batchRetries' | 'batchRetryDelayMs'>,
  progress: ProgressReporter,
  context: Record<string, string | number>,
  sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof RpcReadError) || !error.retryable || attempt >= selection.batchRetries)
        throw error;
      const delayMs = Math.min(selection.batchRetryDelayMs * 2 ** attempt, 60000);
      progress({
        phase: 'batch_retry',
        ...context,
        ...error.details,
        attempt: attempt + 2,
        delayMs,
      });
      await sleep(delayMs);
    }
  }
}
