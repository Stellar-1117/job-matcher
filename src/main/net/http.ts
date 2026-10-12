/**
 * Small HTTP client for job sources: per-host concurrency limit, exponential backoff on 429/5xx and
 * network errors (honouring Retry-After), timeouts, and cancellation via AbortSignal.
 */

const UA_PLATFORM: Record<string, string> = {
  win32: 'Windows NT 10.0; Win64; x64',
  darwin: 'Macintosh; Intel Mac OS X 10_15_7',
  linux: 'X11; Linux x86_64',
};

/**
 * A regular Chrome user agent for this machine. Inside Electron the Chrome version is the real
 * engine's, so what the page sees in JavaScript matches the header — bot checks such as
 * Cloudflare's flag a mismatch.
 */
export const BROWSER_UA = `Mozilla/5.0 (${UA_PLATFORM[process.platform] ?? UA_PLATFORM.win32}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${
  process.versions.chrome?.split('.')[0] ?? '152'
}.0.0.0 Safari/537.36`;

export class HttpError extends Error {
  override name = 'HttpError';
  constructor(
    public status: number,
    public url: string,
    message?: string,
  ) {
    super(message ?? `HTTP ${status} for ${url}`);
  }
}

export interface HttpResponse {
  status: number;
  /** Final URL after redirects. */
  url: string;
  headers: Headers;
  text: string;
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  /** Return non-2xx responses instead of throwing (used by the fetch ladder for 404/410 detection). */
  allowErrorStatus?: boolean;
}

export interface HttpClient {
  request(url: string, opts?: RequestOptions): Promise<HttpResponse>;
  getText(url: string, opts?: RequestOptions): Promise<HttpResponse>;
  getJson<T = unknown>(url: string, opts?: RequestOptions): Promise<T>;
  postJson<T = unknown>(url: string, body: unknown, opts?: RequestOptions): Promise<T>;
}

export interface HttpClientOptions {
  perHostConcurrency?: number;
  maxRetries?: number;
  timeoutMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const RETRYABLE = (status: number) => status === 429 || status === 408 || (status >= 500 && status <= 599);

function abortError(): Error {
  const e = new Error('Cancelled');
  e.name = 'AbortError';
  return e;
}

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Parse Retry-After (seconds or HTTP date) into milliseconds. */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

class HostLimiter {
  private active = new Map<string, number>();
  private waiting = new Map<string, (() => void)[]>();
  constructor(private limit: number) {}

  async acquire(host: string): Promise<() => void> {
    const n = this.active.get(host) ?? 0;
    if (n >= this.limit) {
      await new Promise<void>((resolve) => {
        const q = this.waiting.get(host) ?? [];
        q.push(resolve);
        this.waiting.set(host, q);
      });
    }
    this.active.set(host, (this.active.get(host) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active.set(host, (this.active.get(host) ?? 1) - 1);
      const next = this.waiting.get(host)?.shift();
      if (next) next();
    };
  }
}

export function createHttpClient(options: HttpClientOptions = {}): HttpClient {
  const {
    perHostConcurrency = 3,
    maxRetries = 4,
    timeoutMs = 30_000,
    baseDelayMs = 1000,
    maxDelayMs = 60_000,
    fetchImpl = (...args: Parameters<typeof fetch>) => fetch(...args),
    sleep = defaultSleep,
  } = options;
  const limiter = new HostLimiter(perHostConcurrency);

  async function request(url: string, opts: RequestOptions = {}): Promise<HttpResponse> {
    const host = new URL(url).host;
    let attempt = 0;
    for (;;) {
      if (opts.signal?.aborted) throw abortError();
      const release = await limiter.acquire(host);
      let retryDelay: number | null = null;
      try {
        const timeout = AbortSignal.timeout(timeoutMs);
        const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
        const res = await fetchImpl(url, {
          method: opts.method ?? 'GET',
          headers: {
            'User-Agent': BROWSER_UA,
            'Accept-Language': 'en-US,en;q=0.9',
            ...(opts.headers ?? {}),
          },
          body: opts.body,
          redirect: 'follow',
          signal,
        });
        const text = await res.text();
        if (res.ok || (opts.allowErrorStatus && !RETRYABLE(res.status))) {
          return { status: res.status, url: res.url || url, headers: res.headers, text };
        }
        if (!RETRYABLE(res.status) || attempt >= maxRetries) {
          if (opts.allowErrorStatus) return { status: res.status, url: res.url || url, headers: res.headers, text };
          throw new HttpError(res.status, url);
        }
        retryDelay = retryAfterMs(res.headers.get('retry-after'));
      } catch (e) {
        if (opts.signal?.aborted) throw abortError();
        if (e instanceof HttpError) throw e;
        if (attempt >= maxRetries) {
          const msg = (e as Error).name === 'TimeoutError' ? `Timed out after ${timeoutMs / 1000}s` : (e as Error).message;
          throw new Error(`${msg} (${url})`);
        }
      } finally {
        release();
      }
      const backoff = Math.min(maxDelayMs, retryDelay ?? baseDelayMs * 2 ** attempt + Math.random() * baseDelayMs * 0.5);
      attempt++;
      await sleep(backoff, opts.signal);
    }
  }

  return {
    request,
    getText: (url, opts) => request(url, { ...opts, headers: { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8', ...(opts?.headers ?? {}) } }),
    async getJson<T>(url: string, opts?: RequestOptions) {
      const res = await request(url, { ...opts, headers: { Accept: 'application/json', ...(opts?.headers ?? {}) } });
      try {
        return JSON.parse(res.text) as T;
      } catch {
        throw new Error(`Expected JSON from ${url} but got something else (HTTP ${res.status}).`);
      }
    },
    async postJson<T>(url: string, body: unknown, opts?: RequestOptions) {
      const res = await request(url, {
        ...opts,
        method: 'POST',
        body: JSON.stringify(body),
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(opts?.headers ?? {}) },
      });
      try {
        return JSON.parse(res.text) as T;
      } catch {
        throw new Error(`Expected JSON from ${url} but got something else (HTTP ${res.status}).`);
      }
    },
  };
}

let shared: HttpClient | null = null;
/** App-wide client so per-host limits apply across concurrent runs. */
export function getHttp(): HttpClient {
  shared ??= createHttpClient();
  return shared;
}
