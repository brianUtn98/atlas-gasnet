export interface ProgressEvent {
  phase: string;
  [field: string]: string | number;
}

export type ProgressReporter = (event: ProgressEvent) => void;
export const silentProgress: ProgressReporter = () => {};

/** Log counters periodically, plus durable milestones immediately. Never log RPC errors/URLs. */
export class ConsoleProgress {
  private readonly startedAt: number;
  private lastUpdate = -Infinity;

  constructor(
    private readonly write: (line: string) => void = console.log,
    private readonly now: () => number = Date.now,
    private readonly intervalMs = 1000,
  ) {
    this.startedAt = now();
  }

  readonly report: ProgressReporter = (event) => {
    const now = this.now();
    const frequent = ['scan', 'enrich', 'rpc_retry', 'rpc_wait'].includes(event.phase);
    if (frequent && now - this.lastUpdate < this.intervalMs) return;
    this.lastUpdate = now;
    const details = Object.entries(event)
      .filter(([key]) => key !== 'phase')
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');
    this.write(
      `[${new Date(now).toISOString()}] ${event.phase} elapsed=${((now - this.startedAt) / 1000).toFixed(1)}s ${details}`,
    );
  };
}
