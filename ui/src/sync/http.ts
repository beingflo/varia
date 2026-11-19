// The one place that knows the server exists. Errors keep the status so callers can tell a full
// account from a rate limit.
import type { SyncResponse, Transport } from './client';

export class SyncError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfter?: number,
  ) {
    super(`${status} ${code}`);
  }
}

export function httpTransport(base = '', fetchImpl = fetch): Transport {
  return async (token, body) => {
    const response = await fetchImpl(`${base}/api/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      // A stalled request must fail rather than leave the UI saying "syncing" forever.
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      const detail = (await response.json().catch(() => ({}))) as { error?: string };
      const retry = Number(response.headers.get('retry-after') ?? 0);
      throw new SyncError(response.status, detail.error ?? 'unknown', retry > 0 ? retry : undefined);
    }
    return (await response.json()) as SyncResponse;
  };
}
