/** FIFO permits shared by every physical request, including health probes. */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly queue: (() => void)[] = [];

  constructor(private limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid concurrency limit.');
  }

  get currentLimit(): number {
    return this.limit;
  }

  setLimit(limit: number): void {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid concurrency limit.');
    this.limit = limit;
    this.drain();
  }

  private drain(): void {
    while (this.active < this.limit && this.queue.length) {
      this.active++;
      this.queue.shift()!();
    }
  }

  async acquire(timeoutMs?: number): Promise<() => void> {
    if (this.active >= this.limit || this.queue.length) {
      await new Promise<void>((resolve, reject) => {
        const ready = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer =
          timeoutMs === undefined
            ? undefined
            : setTimeout(() => {
                const index = this.queue.indexOf(ready);
                if (index >= 0) this.queue.splice(index, 1);
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
      this.active--;
      this.drain();
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
