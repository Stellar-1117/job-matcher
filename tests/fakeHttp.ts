import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HttpClient, HttpResponse, RequestOptions } from '../src/main/net/http';
import { HttpError } from '../src/main/net/http';

export const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', 'ats', name), 'utf8');

type Handler = string | { status?: number; text: string; url?: string } | ((url: string, opts?: RequestOptions) => string | { status?: number; text: string; url?: string });

/** HttpClient double: routes are matched by exact URL or by prefix ("prefix*"). Records every call. */
export function fakeHttp(routes: Record<string, Handler>): HttpClient & { calls: { url: string; method: string; body?: string }[] } {
  const calls: { url: string; method: string; body?: string }[] = [];
  const resolve = (url: string): Handler | undefined => {
    if (routes[url] !== undefined) return routes[url];
    const prefix = Object.keys(routes).find((k) => k.endsWith('*') && url.startsWith(k.slice(0, -1)));
    return prefix ? routes[prefix] : undefined;
  };
  async function request(url: string, opts: RequestOptions = {}): Promise<HttpResponse> {
    calls.push({ url, method: opts.method ?? 'GET', body: opts.body });
    if (opts.signal?.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
    const h = resolve(url);
    if (h === undefined) throw new HttpError(404, url);
    const out = typeof h === 'function' ? h(url, opts) : h;
    const r = typeof out === 'string' ? { status: 200, text: out } : { status: out.status ?? 200, text: out.text, url: out.url };
    if (r.status >= 400 && !opts.allowErrorStatus) throw new HttpError(r.status, url);
    return { status: r.status, url: r.url ?? url, headers: new Headers(), text: r.text };
  }
  return {
    calls,
    request,
    getText: (url, opts) => request(url, opts),
    getJson: async (url, opts) => JSON.parse((await request(url, opts)).text),
    postJson: async (url, body, opts) => JSON.parse((await request(url, { ...opts, method: 'POST', body: JSON.stringify(body) })).text),
  };
}
