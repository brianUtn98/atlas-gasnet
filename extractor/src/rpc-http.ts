import type { ProgressReporter } from './progress.js';

/** HTTP batching compatibility and envelope validation, independently per endpoint. */
export class RpcHttp {
  private disabled = false;
  private requests = 0;
  private batches = 0;
  private fallbacks = 0;

  constructor(
    private readonly endpoint: number,
    private readonly progress: ProgressReporter,
    private readonly invalidData: () => Error,
  ) {}

  metrics() {
    return {
      httpRequests: this.requests,
      httpBatches: this.batches,
      batchFallbacks: this.fallbacks,
    };
  }

  private async request(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
    this.requests++;
    const response = await globalThis.fetch(input, init);
    if (response.status === 429 || response.status === 503) {
      await response.body?.cancel();
      // Preserve Retry-After even when an HTTP error contains a JSON-RPC error
      // body that viem would otherwise turn into a headerless RPC error.
      throw Object.assign(new Error('RPC provider is temporarily unavailable.'), {
        status: response.status,
        headers: response.headers,
      });
    }
    return response;
  }

  private validIds(jobs: { id: unknown }[], responses: unknown): boolean {
    if (!Array.isArray(responses) || responses.length !== jobs.length) return false;
    const expected = new Set(jobs.map((job) => JSON.stringify(job.id)));
    const actual = new Set(responses.map((response) => JSON.stringify(response?.id)));
    return actual.size === jobs.length && [...actual].every((id) => expected.has(id));
  }

  private async individual(
    input: Parameters<typeof fetch>[0],
    init: RequestInit | undefined,
    jobs: { id: unknown }[],
  ): Promise<Response> {
    // Drain every HTTP request before releasing the logical batch's permits.
    const settled = await Promise.allSettled(
      jobs.map((job) => this.request(input, { ...init, body: JSON.stringify(job) })),
    );
    const rejected = settled.find((result) => result.status === 'rejected');
    if (rejected?.status === 'rejected') {
      await Promise.allSettled(
        settled
          .filter((result) => result.status === 'fulfilled')
          .map((result) => result.value.body?.cancel()),
      );
      throw rejected.reason;
    }
    const responses = settled.map((result) => {
      if (result.status === 'rejected') throw result.reason;
      return result.value;
    });
    // Retain structured HTTP status/Retry-After for the whole read-only group.
    const failed =
      responses.find((response) => response.status === 429) ??
      responses.find((response) => !response.ok);
    if (failed) {
      await Promise.allSettled(
        responses
          .filter((response) => response !== failed)
          .map((response) => response.body?.cancel()),
      );
      return failed;
    }
    const bodies = await Promise.allSettled(responses.map((response) => response.json()));
    const parsed = bodies.map((result) => {
      if (result.status === 'rejected') throw this.invalidData();
      return result.value;
    });
    if (!this.validIds(jobs, parsed)) throw this.invalidData();
    return new Response(JSON.stringify(parsed), {
      headers: { 'content-type': 'application/json' },
    });
  }

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const jobs = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    if (!Array.isArray(jobs)) return this.request(input, init);
    if (this.disabled) return this.individual(input, init, jobs);
    this.batches++;
    const response = await this.request(input, init);
    if (!response.ok && ![400, 413, 415, 422, 500].includes(response.status)) return response;
    if ([400, 413, 415, 422].includes(response.status)) {
      this.disable();
      await response.body?.cancel();
      return this.individual(input, init, jobs);
    }
    let parsed: unknown;
    try {
      parsed = await response.clone().json();
    } catch {
      if (!response.ok) return response;
      throw this.invalidData();
    }
    const codes = (Array.isArray(parsed) ? parsed : [parsed]).map(
      (entry) => (entry as { error?: { code?: number } } | null)?.error?.code,
    );
    const unsupported =
      codes.length > 0 && codes.every((code) => code === -32600 || code === -32601 || code === 31);
    if (unsupported) {
      this.disable();
      await response.body?.cancel();
      return this.individual(input, init, jobs);
    }
    if (!response.ok) return response;
    if (!this.validIds(jobs, parsed)) throw this.invalidData();
    return response;
  };

  private disable(): void {
    this.fallbacks++;
    if (!this.disabled) this.progress({ phase: 'rpc_batch_disabled', endpoint: this.endpoint });
    this.disabled = true;
  }
}
