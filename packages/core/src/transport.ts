import type { SyncRequest, SyncResponse, Transport } from './types.js';

export interface HttpTransportOptions {
  /** Full URL of the sync endpoint, e.g. https://api.example.com/sync */
  url: string;
  /** Static headers, or a function called before every request (for fresh auth tokens). */
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`Sync failed with HTTP ${status}: ${body.slice(0, 200)}`);
    this.name = 'HttpError';
  }
}

export function httpTransport(options: HttpTransportOptions): Transport {
  const doFetch = options.fetch ?? fetch;
  return {
    async sync(request: SyncRequest): Promise<SyncResponse> {
      const headers =
        typeof options.headers === 'function' ? await options.headers() : options.headers ?? {};
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
      try {
        const res = await doFetch(options.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(request),
          signal: controller.signal,
        });
        if (!res.ok) throw new HttpError(res.status, await res.text());
        return (await res.json()) as SyncResponse;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
