import { beforeEach, describe, expect, it } from 'vitest';
import { fakeHttp } from './fakeHttp';
import { setupTestDb } from './helpers';
import { normalizeUrl } from '../src/main/sources/url';
import { detectAts, hintsFromUrl } from '../src/main/sources/detect';
import { detectEmbeddedAts } from '../src/main/sources';
import { smartRecruitersAdapter } from '../src/main/sources/adapters/smartrecruiters';
import { fetchDescription, resetBlockedHosts, type PageRenderer } from '../src/main/analysis/fetch';
import { addLinks, getJobItem } from '../src/main/repos/jobs';
import { listHumanQueue, markUnreadable, resetAllUnreadable, saveFetchedText } from '../src/main/repos/analysis';
import type { SourceContext } from '../src/main/sources/types';

const NOW = new Date('2026-11-04T12:00:00Z');
const ctx = (http: any): SourceContext => ({ http, now: NOW, range: { from: new Date('2026-10-01T00:00:00Z'), to: NOW } });

const DESC =
  'About the role: you will build payment APIs in Go. Responsibilities include designing services, owning reliability and mentoring engineers. ' +
  'Requirements: 5+ years of backend experience, PostgreSQL, distributed systems. Benefits: health, equity, remote stipend. '.repeat(2);

const SR_POSTING = {
  id: '744000159155109',
  name: 'Platform Engineer',
  releasedDate: '2026-11-02T14:22:55.032Z',
  company: { name: 'RightEye', identifier: 'RightEye' },
  location: { city: 'Bethesda', region: 'MD', country: 'us', remote: true, hybrid: false, fullLocation: 'Bethesda, MD, United States' },
  typeOfEmployment: { label: 'Full-time' },
  postingUrl: 'https://jobs.smartrecruiters.com/RightEye/744000159155109-platform-engineer',
  jobAd: {
    sections: {
      companyDescription: { title: 'Company Description', text: '<p>RightEye builds eye-tracking tools.</p>' },
      jobDescription: { title: 'Job Description', text: `<p>${DESC}</p>` },
      qualifications: { title: 'Qualifications', text: '<ul><li>Go</li><li>Kubernetes</li></ul>' },
    },
  },
};
const SR_API = 'https://api.smartrecruiters.com/v1/companies/RightEye/postings';

describe('SmartRecruiters', () => {
  it('detects job and board URLs', () => {
    expect(detectAts('https://jobs.smartrecruiters.com/RightEye/744000159155109-platform-engineer?jr_id=abc&oga=true')).toEqual({
      ats: 'smartrecruiters',
      boardToken: 'RightEye',
      jobId: '744000159155109',
    });
    expect(detectAts('https://careers.smartrecruiters.com/RightEye')).toEqual({ ats: 'smartrecruiters', boardToken: 'RightEye', jobId: null });
    expect(detectAts('https://jobs.smartrecruiters.com/')).toBeNull();
    expect(hintsFromUrl('https://jobs.smartrecruiters.com/WellmarkInc/744000153829469-sr-software-engineer')).toMatchObject({ sourceKey: 'smartrecruiters', companyName: 'WellmarkInc' });
    expect(detectEmbeddedAts('<a href="https://jobs.smartrecruiters.com/RightEye/744000159155109">Apply</a>')).toMatchObject({ atsType: 'smartrecruiters', boardToken: 'RightEye' });
  });

  it('fetchJob reads the posting API (the job page answers plain fetches with 403)', async () => {
    const http = fakeHttp({ [`${SR_API}/744000159155109`]: JSON.stringify(SR_POSTING) });
    const j = await smartRecruitersAdapter.fetchJob!('https://jobs.smartrecruiters.com/RightEye/744000159155109-platform-engineer?oga=true', ctx(http));
    expect(j).toMatchObject({
      title: 'Platform Engineer',
      companyName: 'RightEye',
      location: 'Bethesda, MD, United States (Remote)',
      postedAt: '2026-11-02T14:22:55.032Z',
      postedAtSource: 'source_republish',
      externalId: '744000159155109',
    });
    expect(j.descriptionText).toMatch(/^Company Description\nRightEye builds/);
    expect(j.descriptionText).toMatch(/Qualifications\n[\s\S]*Kubernetes/);
    expect(j.descriptionText).not.toMatch(/<p>/);
  });

  it('the fetch ladder uses the API for pasted SmartRecruiters links', async () => {
    const http = fakeHttp({ [`${SR_API}/744000159155109`]: JSON.stringify(SR_POSTING) });
    const r = await fetchDescription('https://jobs.smartrecruiters.com/RightEye/744000159155109-platform-engineer', { http, render: null, now: NOW });
    expect(r).toMatchObject({ kind: 'text', via: 'ats', rawSourceKey: 'smartrecruiters' });
    expect(http.calls.map((c) => c.url)).toEqual([`${SR_API}/744000159155109`]);
  });

  it('listJobs pages through the list and fetches postings inside the window', async () => {
    const old = { ...SR_POSTING, id: '1', name: 'Old role', releasedDate: '2026-08-01T00:00:00Z', jobAd: undefined };
    const http = fakeHttp({
      [`${SR_API}?limit=100&offset=0`]: JSON.stringify({ offset: 0, limit: 100, totalFound: 2, content: [{ ...SR_POSTING, jobAd: undefined }, old] }),
      [`${SR_API}/744000159155109`]: JSON.stringify(SR_POSTING),
    });
    const jobs = await smartRecruitersAdapter.listJobs({ id: 1, name: 'RightEye', atsType: 'smartrecruiters', boardToken: 'RightEye', careersUrl: 'https://careers.smartrecruiters.com/RightEye' }, ctx(http));
    expect(jobs.map((j) => j.title)).toEqual(['Platform Engineer', 'Old role']);
    expect(jobs[0].descriptionText).toMatch(/payment APIs/);
    expect(jobs[1].descriptionText).toBeNull();
    expect(http.calls).toHaveLength(2);
  });
});

describe('JobDiva links', () => {
  const LINK = 'https://www1.jobdiva.com/portal/?a=kvjdnwtsxgckrpsoozx5qc0oueybw1005779v7x6soig8eyqqmzaubfdl9tcx21s&jr_id=6aea0b724f991d64376c9cf6#/jobs/33550560';

  it('keep their #/jobs/ route (the posting lives there)', () => {
    const r = normalizeUrl(LINK);
    expect(r).toEqual({ ok: true, url: 'https://www1.jobdiva.com/portal?a=kvjdnwtsxgckrpsoozx5qc0oueybw1005779v7x6soig8eyqqmzaubfdl9tcx21s&jr_id=6aea0b724f991d64376c9cf6#/jobs/33550560' });
    // Other sites still lose their fragments.
    expect(normalizeUrl('https://acme.com/careers/1#/jobs/2')).toEqual({ ok: true, url: 'https://acme.com/careers/1' });
  });

  it('skip the plain fetch (the server only sends the portal front page) and go to the browser', async () => {
    const http = fakeHttp({ 'https://www1.jobdiva.com/*': `<html><body><article>${DESC}</article></body></html>` });
    const rendered: string[] = [];
    const render: PageRenderer = async (url) => {
      rendered.push(url);
      return { url, status: 200, html: `<html><body><main><article><h1>Java Developer</h1><p>${DESC}</p></article></main></body></html>` };
    };
    const url = normalizeUrl(LINK).ok ? (normalizeUrl(LINK) as { url: string }).url : '';
    const r = await fetchDescription(url, { http, render, now: NOW });
    expect(r).toMatchObject({ kind: 'text', via: 'browser' });
    expect(http.calls).toHaveLength(0);
    expect(rendered).toEqual([url]);
  });
});

describe('pages that need a person', () => {
  beforeEach(() => resetBlockedHosts());
  const cloudflare = '<html><head><title>Just a moment...</title></head><body><p>www.ziprecruiter.com</p><p>Performing security verification</p></body></html>';

  it('a bot check in the browser marks the page for the human pass, and later pages of that site skip the browser', async () => {
    const http = fakeHttp({ 'https://ziprecruiter.com/*': { status: 403, text: cloudflare } });
    let renders = 0;
    const render: PageRenderer = async (url) => {
      renders++;
      return { url, status: 403, html: cloudflare, challenge: true };
    };
    const first = await fetchDescription('https://ziprecruiter.com/kn/AAA', { http, render, now: NOW });
    expect(first).toMatchObject({ kind: 'unreadable', block: 'bot_check' });
    const second = await fetchDescription('https://ziprecruiter.com/kn/BBB', { http, render, now: NOW });
    expect(second).toMatchObject({ kind: 'unreadable', block: 'bot_check', reason: expect.stringMatching(/skipped/) });
    expect(renders).toBe(1);
  });

  it('a login wall is a sign-in block; an empty page is no block', async () => {
    const http = fakeHttp({});
    const login: PageRenderer = async (url) => ({ url, status: 200, html: `<html><body><p>Please sign in to view this job. ${'x '.repeat(200)}</p></body></html>` });
    expect(await fetchDescription('https://jobs.example.com/1', { http, render: login, now: NOW })).toMatchObject({ kind: 'unreadable', block: 'login' });
    const empty: PageRenderer = async (url) => ({ url, status: 200, html: '<html><body><p>Loading</p></body></html>' });
    expect(await fetchDescription('https://other.example.com/1', { http, render: empty, now: NOW })).toMatchObject({ kind: 'unreadable', block: null });
  });

  it('text around a bot check is never taken as the posting', async () => {
    // JobDiva shows its company blurb behind the check; Readability would happily return it.
    const html = `<html><body><main><article><h1>About Artech Information Systems LLC</h1><p>${DESC}</p></article></main></body></html>`;
    const render: PageRenderer = async (url) => ({ url, status: 200, html, challenge: true });
    expect(await fetchDescription('https://www1.jobdiva.com/portal?a=y#/jobs/2', { http: fakeHttp({}), render, now: NOW })).toMatchObject({ kind: 'unreadable', block: 'bot_check' });
  });

  it('the JobDiva "Quick security check" is a bot check', async () => {
    const html = `<html><body><p>Employees at Artech value us!</p><div role="dialog" aria-label="Security check"><h2>Quick security check</h2><p>Please confirm you're human to continue. This only takes a moment.</p></div><p>${'About Artech. '.repeat(30)}</p></body></html>`;
    const render: PageRenderer = async (url) => ({ url, status: 200, html, challenge: true });
    expect(await fetchDescription('https://www1.jobdiva.com/portal?a=x#/jobs/1', { http: fakeHttp({}), render, now: NOW })).toMatchObject({ kind: 'unreadable', block: 'bot_check' });
  });
});

describe('human queue', () => {
  beforeEach(() => setupTestDb());

  it('lists blocked jobs grouped by site and clears the block once read or reset', () => {
    const { added } = addLinks('https://ziprecruiter.com/kn/AAA\nhttps://jobs.example.com/1\nhttps://ziprecruiter.com/kn/BBB\nhttps://plain.example.com/2');
    const [zr1, ex, zr2, plain] = added;
    markUnreadable(zr1.id, zr1.url!, 'browser: HTTP 403', 'bot_check');
    markUnreadable(ex.id, ex.url!, 'browser: behind a login wall', 'login');
    markUnreadable(zr2.id, zr2.url!, 'browser: HTTP 403', 'bot_check');
    markUnreadable(plain.id, plain.url!, 'page text too short');
    expect(listHumanQueue().map((j) => [j.jobId, j.host, j.block])).toEqual([
      [zr1.id, 'ziprecruiter.com', 'bot_check'],
      [zr2.id, 'ziprecruiter.com', 'bot_check'],
      [ex.id, 'jobs.example.com', 'login'],
    ]);
    expect(listHumanQueue([ex.id]).map((j) => j.jobId)).toEqual([ex.id]);
    expect(getJobItem(zr1.id)?.fetchBlock).toBe('bot_check');

    saveFetchedText(zr1.id, DESC);
    expect(getJobItem(zr1.id)?.fetchBlock).toBeNull();
    resetAllUnreadable();
    expect(listHumanQueue()).toEqual([]);
  });
});
