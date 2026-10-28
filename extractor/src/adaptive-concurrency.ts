import { ConcurrencyLimiter } from './concurrency.js';
import type { ProgressReporter } from './progress.js';

/** Multiplicative decrease on congestion, additive recovery after healthy windows. */
export class AdaptiveConcurrency {
  private successes = 0;
  private changedAt = -Infinity;

  constructor(
    private readonly limiter: ConcurrencyLimiter,
    private readonly maximum: number,
    private readonly report: ProgressReporter,
    private readonly now: () => number,
  ) {}

  congested(reason: 'rate_limit' | 'timeout' | 'latency'): void {
    this.successes = 0;
    if (this.now() - this.changedAt < 1000) return;
    const previous = this.limiter.currentLimit;
    const next = Math.max(1, Math.floor(previous / 2));
    this.changedAt = this.now();
    this.limiter.setLimit(next);
    if (next !== previous)
      this.report({
        phase: 'rpc_concurrency',
        previous,
        limit: next,
        maximum: this.maximum,
        reason,
      });
  }

  succeeded(durationMs: number, timeoutMs: number): void {
    if (durationMs >= timeoutMs * 0.75) {
      this.congested('latency');
      return;
    }
    this.successes++;
    if (
      this.limiter.currentLimit >= this.maximum ||
      this.successes < Math.max(16, this.limiter.currentLimit * 2) ||
      this.now() - this.changedAt < 1000
    )
      return;
    const previous = this.limiter.currentLimit;
    this.limiter.setLimit(previous + 1);
    this.changedAt = this.now();
    this.successes = 0;
    this.report({
      phase: 'rpc_concurrency',
      previous,
      limit: previous + 1,
      maximum: this.maximum,
      reason: 'recovery',
    });
  }
}
