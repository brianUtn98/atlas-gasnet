/** FIFO permits shared by every physical request, including health probes. */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly queue: (() => void)[] = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid concurrency limit.');
  }

  async acquire(timeoutMs?: number): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const ready = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer =
          timeoutMs === undefined
            ? undefined
            : setTimeout(() => {
                this.queue.splice(this.queue.indexOf(ready), 1);
                reject(new Error('RPC queue timeout.'));
              }, timeoutMs);
        this.queue.push(ready);
      });
    } else {
      this.active++;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) next();
      else this.active--;
    };
  }
}

/** Keep result order, stop scheduling on failure, and drain in-flight workers. */
export async function mapConcurrent<T, R>(
  values: readonly T[],
  limit: number,
  work: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid concurrency limit.');
  const results = new Array<R>(values.length);
  let next = 0;
  let failed = false;
  let failure: unknown;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (!failed && next < values.length) {
        const index = next++;
        try {
          results[index] = await work(values[index], index);
        } catch (error) {
          if (!failed) failure = error;
          failed = true;
        }
      }
    }),
  );
  if (failed) throw failure;
  return results;
}
