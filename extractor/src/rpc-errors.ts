/** Only structured metadata is retained: provider messages can contain secrets. */
export function rpcFailure(error: unknown): Record<string, string | number> {
  let current = error as {
    cause?: unknown;
    status?: number;
    code?: number;
    name?: string;
    reason?: string;
  };
  const result: Record<string, string | number> = { category: 'transport' };
  for (let depth = 0; current && depth < 8; depth++, current = current.cause as typeof current) {
    if (current.name === 'InvalidData') {
      result.category = 'invalid_response';
      if (current.reason && /^[a-z_]{1,64}$/.test(current.reason)) result.reason = current.reason;
    }
    if (current.name === 'ReceiptUnavailable') result.category = 'receipt_unavailable';
    if (current.name === 'TimeoutError') result.category = 'timeout';
    if (Number.isInteger(current.status)) result.httpStatus = current.status!;
    if (Number.isInteger(current.code)) result.rpcCode = current.code!;
  }
  return result;
}

export class RpcReadError extends Error {
  constructor(
    network: string,
    readonly details: Record<string, string | number>,
    readonly retryable = true,
  ) {
    super(`RPC reads exhausted for ${network}; no progress committed.`);
    this.name = 'RpcReadError';
  }
}

export function failureDetails(error: unknown): Record<string, string | number> {
  if (error instanceof RpcReadError) return error.details;
  // Only allow known OS error codes, never arbitrary external text or paths.
  const code = (error as { code?: unknown } | null)?.code;
  return {
    category: typeof code === 'string' && /^E[A-Z]{2,20}$/.test(code) ? code : 'application',
  };
}
