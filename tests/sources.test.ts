import { beforeEach, describe, expect, it } from 'vitest';
import { setupTestDb } from './helpers';
import { fakeHttp, fixture } from './fakeHttp';
import { getDb } from '../src/main/db';
import { addLinks, listJobs, upsertCollectedJob } from '../src/main/repos/jobs';
import { isInRange, parseRelativePosted, resolveDateRange, startOfLocalDay } from '../src/main/sources/dates';
import { dedupeKey, normalizeCompany, normalizeTitle } from '../src/main/sources/dedupe';
import { createHttpClient, retryAfterMs } from '../src/main/net/http';
import type { RawJob } from '../src/main/sources/types';

const NOW = new Date('2026-09-30T12:00:00Z');
const GH_LIST = 'https://boards-api.greenhouse.io/v1/boards/stripe/jobs?content=true';

beforeEach(() => setupTestDb());

describe('dates', () => {
  it('resolves presets and custom ranges', () => {
    expect(resolveDateRange({ preset: 'today', from: null, to: null }, NOW).from).toEqual(startOfLocalDay(NOW));
    expect(resolveDateRange({ preset: 'last7', from: null, to: null }, NOW).from).toEqual(new Date(NOW.getTime() - 7 * 86400_000));
    const c = resolveDateRange({ preset: 'custom', from: '2026-09-01', to: '2026-09-10' }, NOW);
    expect(c.from).toEqual(new Date(2026, 8, 1));
    expect(c.to).toEqual(new Date(2026, 8, 10, 23, 59, 59, 999));
  });

  it('parses Workday relative dates', () => {
    expect(parseRelativePosted('Posted Today', NOW)!.postedAt).toBe(startOfLocalDay(NOW).toISOString());
    expect(parseRelativePosted('Posted 5 Days Ago', NOW)!.postedAt).toBe(startOfLocalDay(new Date(NOW.getTime() - 5 * 86400_000)).toISOString());
    expect(parseRelativePosted('Posted 30+ Days Ago', NOW)).toEqual({ postedAt: null, postedBefore: new Date(NOW.getTime() - 30 * 86400_000).toISOString() });
    expect(parseRelativePosted('Recently', NOW)).toBeNull();
  });

  it('filters by posted date, then the known upper bound, then first seen', () => {
    const range = { from: new Date(NOW.getTime() - 7 * 86400_000), to: NOW };
    const seen = NOW.toISOString();
    expect(isInRange({ postedAt: '2026-09-29T10:00:00Z' }, seen, range)).toBe(true);
    expect(isInRange({ postedAt: '2026-09-01T10:00:00Z' }, seen, range)).toBe(false);
    expect(isInRange({ postedAt: null, postedBefore: '2026-08-31T00:00:00Z' }, seen, range)).toBe(false);
    expect(isInRange({ postedAt: null, postedBefore: range.from.toISOString() }, seen, range)).toBe(false); // boundary
    expect(isInRange({ postedAt: null, postedBefore: '2026-09-29T00:00:00Z' }, seen, range)).toBe(true); // bound inside the window
    expect(isInRange({ postedAt: null }, seen, range)).toBe(true); // undated → first seen now
    expect(isInRange({ postedAt: null }, '2026-08-01T00:00:00Z', range)).toBe(false);
  });
});

describe('dedupe keys', () => {
  it('normalizes company, title and location', () => {
    expect(normalizeCompany('Acme, Inc.')).toBe('acme');
    expect(normalizeTitle('Sr. Backend Eng (Remote)')).toBe('senior backend engineer');
    expect(dedupeKey('Acme Inc', 'Sr Backend Engineer', 'Remote - United States')).toBe('acme|senior backend engineer|us');
    expect(dedupeKey(null, 'x', 'y')).toBeNull();
  });
});

describe('http client', () => {
  it('retries 429/5xx with backoff and honours Retry-After', async () => {
    const statuses = [429, 503, 200];
    const sleeps: number[] = [];
    const http = createHttpClient({
      fetchImpl: (async () => {
        const s = statuses.shift()!;
        return new Response(s === 200 ? '{"ok":true}' : 'busy', { status: s, headers: s === 429 ? { 'retry-after': '2' } : {} });
      }) as typeof fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      baseDelayMs: 100,
    });
    expect(await http.getJson('https://api.example.com/x')).toEqual({ ok: true });
    expect(sleeps[0]).toBe(2000);
    expect(sleeps[1]).toBeGreaterThanOrEqual(200);
  });

  it('does not retry 404 and reports the status', async () => {
    let calls = 0;
    const http = createHttpClient({ fetchImpl: (async () => (calls++, new Response('no', { status: 404 }))) as typeof fetch, sleep: async () => {} });
    await expect(http.getText('https://x.com/a')).rejects.toThrow(/HTTP 404/);
    expect(calls).toBe(1);
  });

  it('limits concurrency per host', async () => {
    let inFlight = 0;
    let peak = 0;
    const http = createHttpClient({
      perHostConcurrency: 2,
      fetchImpl: (async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
        return new Response('ok');
      }) as typeof fetch,
    });
    await Promise.all(Array.from({ length: 6 }, () => http.getText('https://same.host/x')));
    expect(peak).toBe(2);
  });

  it('parses Retry-After dates', () => {
    expect(retryAfterMs('Wed, 30 Sep 2026 12:00:10 GMT', NOW.getTime())).toBe(10_000);
  });
});

describe('job merging', () => {
  const raw = (over: Partial<RawJob>): RawJob => ({
    url: 'https://job-boards.greenhouse.io/acme/jobs/1',
    externalId: '1',
    title: 'Backend Engineer',
    companyName: 'Acme',
    location: 'Berlin',
    postedAt: '2026-09-28T00:00:00.000Z',
    postedAtSource: 'source',
    descriptionText: 'Build things',
    ...over,
  });
  const now = NOW.toISOString();

  it('pasted platform link + ATS posting of the same job → one job, ATS URL primary', () => {
    addLinks('https://www.linkedin.com/jobs/view/backend-engineer-at-acme-3812345678');
    expect(listJobs()).toHaveLength(1);
    const r = upsertCollectedJob(raw({}), { sourceKey: 'greenhouse', companyId: null, now, insertIfNew: true });
    expect(r.outcome).toBe('merged');
    const jobs = listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ url: 'https://job-boards.greenhouse.io/acme/jobs/1', sourceKey: 'greenhouse', location: 'Berlin', postedAtSource: 'source', hasDescription: true, fetchStatus: 'fetched' });
    expect(jobs[0].extraUrls).toEqual(['https://linkedin.com/jobs/view/3812345678']);
  });

  it('pasting a platform link for an already-collected job is recognised as the same job', () => {
    upsertCollectedJob(raw({}), { sourceKey: 'greenhouse', companyId: null, now, insertIfNew: true });
    const r = addLinks('https://www.linkedin.com/jobs/view/backend-engineer-at-acme-3812345678');
    expect(r.added).toHaveLength(0);
    expect(r.duplicates[0]).toMatchObject({ reason: 'same_job' });
    expect(listJobs()[0].extraUrls).toEqual(['https://linkedin.com/jobs/view/3812345678']);
  });

  it('re-collecting updates last seen but keeps first seen; alternate URLs match', () => {
    upsertCollectedJob(raw({ url: 'https://acme.com/careers?gh_jid=1', altUrls: ['https://job-boards.greenhouse.io/acme/jobs/1'] }), { sourceKey: 'greenhouse', companyId: null, now: '2026-09-28T00:00:00.000Z', insertIfNew: true });
    const again = upsertCollectedJob(raw({ url: 'https://acme.com/careers?gh_jid=1', title: 'Backend Engineer II' }), { sourceKey: 'greenhouse', companyId: null, now, insertIfNew: false });
    expect(again.outcome).toBe('updated');
    const [j] = listJobs();
    expect(j).toMatchObject({ firstSeenAt: '2026-09-28T00:00:00.000Z', lastSeenAt: now, title: 'Backend Engineer II' });
    expect(addLinks('https://boards.greenhouse.io/acme/jobs/1?gh_src=x').duplicates[0]).toMatchObject({ reason: 'already_saved', jobId: j.id });
  });

  it('keeps two different postings from the same board apart even with the same title and location', () => {
    upsertCollectedJob(raw({}), { sourceKey: 'greenhouse', companyId: null, now, insertIfNew: true });
    const r = upsertCollectedJob(raw({ url: 'https://job-boards.greenhouse.io/acme/jobs/2', externalId: '2' }), { sourceKey: 'greenhouse', companyId: null, now, insertIfNew: true });
    expect(r.outcome).toBe('new');
    expect(listJobs()).toHaveLength(2);
  });

  it('does not insert out-of-range postings', () => {
    expect(upsertCollectedJob(raw({}), { sourceKey: 'greenhouse', companyId: null, now, insertIfNew: false }).outcome).toBe('skipped');
    expect(listJobs()).toHaveLength(0);
  });
});
