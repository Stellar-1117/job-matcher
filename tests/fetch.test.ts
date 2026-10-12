import { describe, expect, it } from 'vitest';
import { fakeHttp } from './fakeHttp';
import { assessText, fetchDescription, type PageRenderer } from '../src/main/analysis/fetch';
import { closedPhrase, expiredByValidThrough, isGenericCareersRedirect, looksOdd } from '../src/main/analysis/closed';

const NOW = new Date('2026-09-30T12:00:00Z');

const DESC =
  'About the role: you will build payment APIs in Go. Responsibilities include designing services, owning reliability and mentoring engineers. ' +
  'Requirements: 5+ years of backend experience, PostgreSQL, distributed systems. Benefits: health, equity, remote stipend. '.repeat(2);

const page = (body: string, head = '') => `<html><head><title>Senior Backend Engineer | Acme</title>${head}</head><body><main><article><h1>Senior Backend Engineer</h1>${body}</article></main></body></html>`;
const jsonLd = (extra: Record<string, unknown> = {}) =>
  `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: 'Senior Backend Engineer',
    description: `<p>${DESC}</p>`,
    datePosted: '2026-09-28',
    hiringOrganization: { '@type': 'Organization', name: 'Acme' },
    jobLocation: { '@type': 'Place', address: { addressLocality: 'Berlin', addressCountry: 'DE' } },
    ...extra,
  })}</script>`;

describe('closed rules', () => {
  it('finds closed phrases', () => {
    expect(closedPhrase('Senior Engineer\nThis job is no longer accepting applications.')).toMatch(/no longer accepting applications/);
    expect(closedPhrase('Sorry, this position has been filled.')).toMatch(/position has been filled/);
    expect(closedPhrase('The job you are looking for is no longer available')).not.toBeNull();
    expect(closedPhrase(DESC)).toBeNull();
  });

  it('recognises redirects to a careers listing', () => {
    expect(isGenericCareersRedirect('https://job-boards.greenhouse.io/acme/jobs/1', 'https://job-boards.greenhouse.io/acme?error=true')).toBe(true);
    expect(isGenericCareersRedirect('https://acme.com/careers/jobs/123', 'https://acme.com/careers')).toBe(true);
    expect(isGenericCareersRedirect('https://acme.com/careers/jobs/123', 'https://www.acme.com/careers/jobs/123/')).toBe(false);
    expect(isGenericCareersRedirect('https://linkedin.com/jobs/view/123', 'https://www.linkedin.com/jobs/view/123')).toBe(false);
    // ZipRecruiter sends expired job links to its search page.
    expect(isGenericCareersRedirect('https://ziprecruiter.com/kn/AAIS4F', 'https://www.ziprecruiter.com/jobs-search?lk=x')).toBe(true);
    expect(isGenericCareersRedirect('https://ziprecruiter.com/kn/AAIS4F', 'https://www.ziprecruiter.com/jobs/v2/eyJsaXN0')).toBe(false);
  });

  it('validThrough, odd text and readability checks', () => {
    expect(expiredByValidThrough('2026-09-29', NOW)).toBe(true);
    expect(expiredByValidThrough('2026-09-30', NOW)).toBe(false); // through the end of that day
    expect(expiredByValidThrough(null, NOW)).toBe(false);
    expect(looksOdd('Page not found')).toBe(true);
    expect(looksOdd(DESC.repeat(2))).toBe(false);
    expect(assessText('short')).toMatch(/too short/);
    expect(assessText(`Sign in to view this job. ${'x '.repeat(200)}`)).toBe('behind a login wall');
    expect(assessText(DESC)).toBeNull();
  });
});

describe('fetch ladder', () => {
  it('uses the ATS API first and treats a 404 there as closed', async () => {
    const http = fakeHttp({
      'https://boards-api.greenhouse.io/v1/boards/acme/jobs/7': JSON.stringify({ id: 7, title: 'Backend Engineer', updated_at: '2026-09-28T00:00:00Z', first_published: '2026-09-20T00:00:00Z', absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/7', content: `&lt;p&gt;${DESC}&lt;/p&gt;` }),
    });
    const ok = await fetchDescription('https://job-boards.greenhouse.io/acme/jobs/7', { http, render: null, now: NOW });
    expect(ok).toMatchObject({ kind: 'text', via: 'ats', rawSourceKey: 'greenhouse' });
    expect(ok.kind === 'text' && ok.raw?.postedAt).toBe('2026-09-20T00:00:00.000Z');

    const gone = await fetchDescription('https://job-boards.greenhouse.io/acme/jobs/8', { http, render: null, now: NOW });
    expect(gone).toMatchObject({ kind: 'closed', via: 'ats' });
    expect(gone.kind === 'closed' && gone.reason).toMatch(/no longer lists/);
  });

  it('reads JSON-LD from a plain GET and returns structured data', async () => {
    const http = fakeHttp({ 'https://jobright.ai/jobs/info/1': page('<div id="app"></div>', jsonLd()) });
    const r = await fetchDescription('https://jobright.ai/jobs/info/1', { http, render: null, now: NOW });
    expect(r.kind).toBe('text');
    if (r.kind !== 'text') return;
    expect(r.via).toBe('http');
    expect(r.text).toContain('payment APIs');
    expect(r.raw).toMatchObject({ title: 'Senior Backend Engineer', companyName: 'Acme', location: 'Berlin, DE', postedAtSource: 'source', url: 'https://jobright.ai/jobs/info/1' });
  });

  it('falls back to Readability text', async () => {
    const http = fakeHttp({ 'https://acme.com/careers/jobs/1': page(`<p>${DESC}</p>`) });
    const r = await fetchDescription('https://acme.com/careers/jobs/1', { http, render: null, now: NOW });
    expect(r).toMatchObject({ kind: 'text', via: 'http', raw: null });
  });

  it('detects closed postings: 404/410, careers redirect, expired JSON-LD, closed banner', async () => {
    const http = fakeHttp({
      'https://acme.com/jobs/404': { status: 404, text: 'not found' },
      'https://acme.com/careers/jobs/9': { url: 'https://acme.com/careers', text: page('<p>All our open roles</p>') },
      'https://acme.com/jobs/expired': page('', jsonLd({ validThrough: '2026-09-01' })),
      'https://acme.com/jobs/banner': page(`<p>This job is no longer accepting applications.</p><p>${DESC}</p>`),
    });
    const deps = { http, render: null, now: NOW };
    expect((await fetchDescription('https://acme.com/jobs/404', deps)).kind).toBe('closed');
    expect(await fetchDescription('https://acme.com/careers/jobs/9', deps)).toMatchObject({ kind: 'closed', reason: expect.stringMatching(/redirects/) });
    expect(await fetchDescription('https://acme.com/jobs/expired', deps)).toMatchObject({ kind: 'closed', reason: expect.stringMatching(/expired/) });
    expect(await fetchDescription('https://acme.com/jobs/banner', deps)).toMatchObject({ kind: 'closed', reason: expect.stringMatching(/no longer accepting/) });
  });

  it('renders JavaScript pages in the hidden browser when plain HTTP has no text', async () => {
    const http = fakeHttp({ 'https://spa.example.com/job/1': page('<div id="root"></div><noscript>Enable JavaScript</noscript>') });
    const rendered: string[] = [];
    const render: PageRenderer = async (url) => {
      rendered.push(url);
      return { url, status: 200, html: page(`<p>${DESC}</p>`) };
    };
    const r = await fetchDescription('https://spa.example.com/job/1', { http, render, now: NOW });
    expect(rendered).toEqual(['https://spa.example.com/job/1']);
    expect(r).toMatchObject({ kind: 'text', via: 'browser' });
  });

  it('gives up as unreadable with every reason', async () => {
    const http = fakeHttp({ 'https://linkedin.com/jobs/view/1': page('<p>Sign in to view this job and more.</p>') });
    const render: PageRenderer = async (url) => ({ url, status: 200, html: page('<p>Join LinkedIn to see who you know. Sign in to view more jobs.</p>') });
    const r = await fetchDescription('https://linkedin.com/jobs/view/1', { http, render, now: NOW });
    expect(r.kind).toBe('unreadable');
    expect(r.kind === 'unreadable' && r.reason).toMatch(/page: .*· browser: /);
  });
});
