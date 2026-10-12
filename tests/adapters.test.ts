import { describe, expect, it } from 'vitest';
import { fakeHttp, fixture } from './fakeHttp';
import { greenhouseAdapter } from '../src/main/sources/adapters/greenhouse';
import { leverAdapter } from '../src/main/sources/adapters/lever';
import { ashbyAdapter } from '../src/main/sources/adapters/ashby';
import { workdayAdapter } from '../src/main/sources/adapters/workday';
import { genericAdapter, jobLinksFromHtml } from '../src/main/sources/adapters/generic';
import { icimsAdapter, parseIcimsSearch } from '../src/main/sources/adapters/icims';
import { detectCompany, detectEmbeddedAts } from '../src/main/sources';
import { decodeEntities, extractJsonLdJobPostings, htmlToText } from '../src/main/sources/html';
import type { CompanyRef, SourceContext } from '../src/main/sources/types';

const NOW = new Date('2026-09-30T12:00:00Z');
const ctx = (http: any, fromDays = 30): SourceContext => ({ http, now: NOW, range: { from: new Date(NOW.getTime() - fromDays * 86400_000), to: NOW } });
const company = (atsType: CompanyRef['atsType'], boardToken: string | null, careersUrl: string, name = 'Acme'): CompanyRef => ({ id: 1, name, atsType, boardToken, careersUrl });

describe('greenhouse', () => {
  const GH_LIST = 'https://boards-api.greenhouse.io/v1/boards/stripe/jobs?content=true';
  const gh = JSON.parse(fixture('greenhouse-list.json'));
  const missingId = gh.jobs[3].id;

  it('parses the list with first_published as the posted date', async () => {
    const http = fakeHttp({ [GH_LIST]: fixture('greenhouse-list.json'), [`https://boards-api.greenhouse.io/v1/boards/stripe/jobs/${missingId}`]: fixture('greenhouse-job.json') });
    const jobs = await greenhouseAdapter.listJobs(company('greenhouse', 'stripe', 'https://job-boards.greenhouse.io/stripe', 'Stripe'), ctx(http));
    expect(jobs).toHaveLength(4);
    const first = jobs[0];
    expect(first).toMatchObject({
      title: gh.jobs[0].title,
      companyName: 'Stripe',
      location: gh.jobs[0].location.name,
      postedAt: new Date('2026-09-29T10:50:29-04:00').toISOString(),
      postedAtSource: 'source',
      externalId: String(gh.jobs[0].id),
      url: gh.jobs[0].absolute_url,
    });
    expect(first.altUrls).toEqual([`https://job-boards.greenhouse.io/stripe/jobs/${gh.jobs[0].id}`]);
    // HTML-escaped content is decoded and converted to text.
    expect(first.descriptionText).toMatch(/About Stripe/);
    expect(first.descriptionText).not.toMatch(/&lt;|<h2>/);
    // The posting without first_published falls back to the single-job endpoint.
    expect(jobs[3].postedAt).toBe(new Date('2026-09-26T08:00:00-04:00').toISOString());
    expect(http.calls.filter((c) => c.url.includes(`/jobs/${missingId}`))).toHaveLength(1);
  });

  it('skips the detail request when updated_at is before the window', async () => {
    const http = fakeHttp({ [GH_LIST]: fixture('greenhouse-list.json') });
    const jobs = await greenhouseAdapter.listJobs(company('greenhouse', 'stripe', 'x'), ctx(http, 1));
    expect(http.calls).toHaveLength(1);
    expect(jobs[3]).toMatchObject({ postedAt: null, postedAtSource: 'first_seen', postedBefore: new Date('2026-09-27T09:00:00-04:00').toISOString() });
  });

  it('fetchJob reads the single-job endpoint', async () => {
    const http = fakeHttp({ [`https://boards-api.greenhouse.io/v1/boards/stripe/jobs/${missingId}`]: fixture('greenhouse-job.json') });
    const j = await greenhouseAdapter.fetchJob!(`https://job-boards.greenhouse.io/stripe/jobs/${missingId}`, ctx(http));
    expect(j.postedAt).toBe(new Date('2026-09-26T08:00:00-04:00').toISOString());
    expect(j.companyName).toBe('Stripe');
  });
});

describe('lever', () => {
  it('parses postings with createdAt as the posted date', async () => {
    const http = fakeHttp({ 'https://api.lever.co/v0/postings/leverdemo?mode=json': fixture('lever-list.json') });
    const jobs = await leverAdapter.listJobs(company('lever', 'leverdemo', 'https://jobs.lever.co/leverdemo'), ctx(http));
    const src = JSON.parse(fixture('lever-list.json'));
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      title: src[0].text,
      url: src[0].hostedUrl,
      externalId: src[0].id,
      postedAt: '2026-09-28T15:00:00.000Z',
      postedAtSource: 'source',
      companyName: 'Acme',
    });
    expect(jobs[0].location).toContain(src[0].categories.location);
    expect(jobs[0].descriptionText!.length).toBeGreaterThan(50);
  });

  it('uses the EU API host for jobs.eu.lever.co boards', async () => {
    const http = fakeHttp({ 'https://api.eu.lever.co/v0/postings/acme?mode=json': '[]' });
    await leverAdapter.listJobs(company('lever', 'acme', 'https://jobs.eu.lever.co/acme'), ctx(http));
    expect(http.calls[0].url).toBe('https://api.eu.lever.co/v0/postings/acme?mode=json');
  });
});

describe('ashby', () => {
  it('parses listed jobs, marking publishedAt as a republish date', async () => {
    const http = fakeHttp({ 'https://api.ashbyhq.com/posting-api/job-board/ashby?includeCompensation=true': fixture('ashby-board.json') });
    const jobs = await ashbyAdapter.listJobs(company('ashby', 'ashby', 'https://jobs.ashbyhq.com/ashby'), ctx(http));
    const src = JSON.parse(fixture('ashby-board.json'));
    expect(jobs).toHaveLength(3); // the unlisted one is dropped
    expect(jobs[0]).toMatchObject({ title: src.jobs[0].title, url: src.jobs[0].jobUrl, postedAtSource: 'source_republish', postedAt: '2026-09-29T12:00:00.000Z' });
    expect(jobs[0].location).toContain(src.jobs[0].location);
    expect(jobs[0].location).toContain(`(${src.jobs[0].workplaceType})`);
  });

  it('fetchJob finds the posting on the board', async () => {
    const src = JSON.parse(fixture('ashby-board.json'));
    const http = fakeHttp({ 'https://api.ashbyhq.com/posting-api/job-board/ashby?includeCompensation=true': fixture('ashby-board.json') });
    const j = await ashbyAdapter.fetchJob!(`https://jobs.ashbyhq.com/ashby/${src.jobs[1].id}`, ctx(http));
    expect(j.title).toBe(src.jobs[1].title);
  });
});

describe('workday', () => {
  const LIST = 'https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/jobs';
  const careers = 'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite';

  it('converts relative dates and stops paging at older postings', async () => {
    const http = fakeHttp({ [LIST]: (_u, opts) => (JSON.parse(opts!.body!).offset === 0 ? fixture('workday-page1.json') : JSON.stringify({ jobPostings: [] })) });
    const jobs = await workdayAdapter.listJobs(company('workday', 'nvidia/NVIDIAExternalCareerSite', careers, 'NVIDIA'), ctx(http));
    expect(jobs).toHaveLength(5);
    const local = (daysAgo: number) => {
      const d = new Date(NOW.getTime() - daysAgo * 86400_000);
      return new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();
    };
    expect(jobs.map((j) => [j.postedAt, j.postedAtSource])).toEqual([
      [local(0), 'relative'],
      [local(1), 'relative'],
      [local(3), 'relative'],
      [local(10), 'relative'],
      [null, 'first_seen'],
    ]);
    expect(jobs[4].postedBefore).toBe(new Date(NOW.getTime() - 30 * 86400_000).toISOString());
    expect(jobs[0].url).toMatch(/^https:\/\/nvidia\.wd5\.myworkdayjobs\.com\/NVIDIAExternalCareerSite\/job\//);
    expect(http.calls[0]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(http.calls[0].body!)).toMatchObject({ limit: 20, offset: 0 });
  });

  it('fetchJob uses the exact startDate', async () => {
    const http = fakeHttp({ 'https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Senior-DFT-Engineer_JR2000499': fixture('workday-detail.json') });
    const j = await workdayAdapter.fetchJob!('https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Senior-DFT-Engineer_JR2000499', ctx(http));
    expect(j).toMatchObject({ title: 'Senior DFT Engineer', postedAtSource: 'source', externalId: 'JR2000499' });
    expect(new Date(j.postedAt!).getDate()).toBe(30);
    expect(j.descriptionText).toMatch(/NVIDIA/);
  });
});

describe('generic', () => {
  const JSONLD = `<html><head><script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'Organization', name: 'Acme' },
      {
        '@type': 'JobPosting',
        title: 'Backend Engineer',
        datePosted: '2026-09-27',
        url: '/careers/backend-engineer',
        hiringOrganization: { '@type': 'Organization', name: 'Acme Inc' },
        jobLocation: { '@type': 'Place', address: { addressLocality: 'Berlin', addressCountry: 'DE' } },
        description: '&lt;p&gt;Build APIs&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Go&lt;/li&gt;&lt;/ul&gt;',
        employmentType: 'FULL_TIME',
      },
    ],
  })}</script></head><body></body></html>`;

  it('reads JSON-LD JobPosting', async () => {
    const http = fakeHttp({ 'https://acme.com/careers': JSONLD });
    const jobs = await genericAdapter.listJobs(company('generic', null, 'https://acme.com/careers'), ctx(http));
    expect(jobs).toEqual([
      expect.objectContaining({
        title: 'Backend Engineer',
        url: 'https://acme.com/careers/backend-engineer',
        companyName: 'Acme Inc',
        location: 'Berlin, DE',
        postedAtSource: 'source',
        descriptionText: 'Build APIs\n\n- Go',
      }),
    ]);
  });

  it('falls back to job-looking links on the page', () => {
    const html = `<a href="/careers">Careers</a><a href="/jobs/123-senior-go-engineer"><h3>Senior Go Engineer</h3><span>Berlin</span></a>
      <a href="https://acme.com/jobs/456">Product Designer</a><a href="https://other.com/jobs/1">Elsewhere</a><a href="/jobs/123-senior-go-engineer">Apply</a>`;
    expect(jobLinksFromHtml(html, 'https://acme.com/careers')).toEqual([
      { url: 'https://acme.com/jobs/123-senior-go-engineer', title: 'Senior Go Engineer' },
      { url: 'https://acme.com/jobs/456', title: 'Product Designer' },
    ]);
  });

  it('reports pages with no detectable jobs as an error', async () => {
    const http = fakeHttp({ 'https://acme.com/careers': '<html><body><div id="root"></div></body></html>' });
    await expect(genericAdapter.listJobs(company('generic', null, 'https://acme.com/careers'), ctx(http))).rejects.toThrow(/No job postings found/);
  });

  it('fetchJob uses Readability when there is no JSON-LD', async () => {
    const body = '<p>' + 'We are hiring a staff engineer to build our payment platform. '.repeat(20) + '</p>';
    const http = fakeHttp({ 'https://acme.com/jobs/1': `<html><head><title>Staff Engineer | Acme</title></head><body><nav>Home</nav><article><h1>Staff Engineer</h1>${body}</article></body></html>` });
    const j = await genericAdapter.fetchJob!('https://acme.com/jobs/1', ctx(http));
    expect(j.descriptionText).toMatch(/payment platform/);
    expect(j.title).toMatch(/Staff Engineer/);
  });
});

describe('ATS detection', () => {
  it('detects embedded boards on a careers page', () => {
    expect(detectEmbeddedAts('<script src="https://boards.greenhouse.io/embed/job_board/js?for=acme"></script>')).toMatchObject({ atsType: 'greenhouse', boardToken: 'acme' });
    expect(detectEmbeddedAts('<a href="https://jobs.lever.co/acme-co/123">x</a>')).toMatchObject({ atsType: 'lever', boardToken: 'acme-co' });
    expect(detectEmbeddedAts('<iframe src="https://jobs.ashbyhq.com/Acme/embed"></iframe>')).toMatchObject({ atsType: 'ashby', boardToken: 'Acme' });
    expect(detectEmbeddedAts('<a href="https://acme.wd1.myworkdayjobs.com/en-US/External">Jobs</a>')).toMatchObject({ atsType: 'workday', boardToken: 'acme/External' });
    expect(detectEmbeddedAts('<html>nothing</html>')).toBeNull();
  });

  it('detectCompany: from URL, from page, and generic fallback', async () => {
    const http = fakeHttp({
      'https://acme.com/careers': '<html><head><meta property="og:site_name" content="Acme"></head><script src="https://boards.greenhouse.io/embed/job_board/js?for=acme"></script></html>',
      'https://plain.com/jobs': '<html><head><title>Careers | Plain Co</title></head></html>',
    });
    expect(await detectCompany('https://jobs.lever.co/acme?lever-source=x', http)).toMatchObject({ atsType: 'lever', boardToken: 'acme', detectedFrom: 'url', careersUrl: 'https://jobs.lever.co/acme' });
    expect(await detectCompany('acme.com/careers', http)).toMatchObject({ atsType: 'greenhouse', boardToken: 'acme', detectedFrom: 'page', suggestedName: 'Acme', careersUrl: 'https://job-boards.greenhouse.io/acme' });
    expect(await detectCompany('https://plain.com/jobs', http)).toMatchObject({ atsType: 'generic', boardToken: null, detectedFrom: 'none', suggestedName: 'Plain Co' });
  });
});

describe('html helpers', () => {
  it('decodes entities and converts HTML to text', () => {
    expect(decodeEntities('&lt;p&gt;Hi &amp; bye&lt;/p&gt;')).toBe('<p>Hi & bye</p>');
    expect(htmlToText('<h2>Role</h2><p>Build <b>things</b>.</p><ul><li>Go</li><li>SQL</li></ul><p>Line<br>break</p>')).toBe('Role\n\nBuild things.\n\n- Go\n- SQL\n\nLine\nbreak');
  });

  it('ignores invalid JSON-LD', () => {
    expect(extractJsonLdJobPostings('<script type="application/ld+json">{oops</script>', 'https://x.com')).toEqual([]);
  });
});

describe('icims', () => {
  const SEARCH0 = 'https://globalcareers-sas.icims.com/jobs/search?pr=0&in_iframe=1';
  const detailFor = (id: string, datePosted: string) =>
    fixture('icims-job.html').replace(/"datePosted":"[^"]*"/, `"datePosted":"${datePosted}"`).replace(/"url":"[^"]*"/, `"url":"https://careers-sas.icims.com/jobs/${id}/job"`);

  it('parses job cards from the search page', () => {
    const { cards, pageCount } = parseIcimsSearch(fixture('icims-search-p0.html'), SEARCH0);
    expect(pageCount).toBe(11);
    expect(cards).toHaveLength(4);
    expect(cards[0]).toEqual({
      url: 'https://careers-sas.icims.com/jobs/42981/job',
      id: '42981',
      title: 'Unreal Developer',
      location: 'United States, Remote',
      category: 'Research and Development',
    });
  });

  it('lists jobs with dates and descriptions from the detail pages, stopping at old postings', async () => {
    const { cards } = parseIcimsSearch(fixture('icims-search-p0.html'), SEARCH0);
    const dates = ['2026-09-29T04:00:00.000Z', '2026-09-25T04:00:00.000Z', '2026-08-01T04:00:00.000Z', '2026-07-01T04:00:00.000Z'];
    const routes: Record<string, string> = { [SEARCH0]: fixture('icims-search-p0.html') };
    cards.forEach((c: any, i: number) => (routes[`${c.url}?in_iframe=1`] = detailFor(c.id, dates[i])));
    // Remaining pages are empty in this fixture.
    routes['https://globalcareers-sas.icims.com/jobs/search?pr=*'] = '<div class="iCIMS_JobsTable"></div>';
    const http = fakeHttp(routes);
    const jobs = await icimsAdapter.listJobs(company('icims', 'globalcareers-sas', 'https://globalcareers-sas.icims.com/jobs/search?ss=1', 'SAS'), ctx(http, 7));
    expect(jobs).toHaveLength(4);
    expect(jobs.map((j: any) => j.postedAt)).toEqual(dates);
    expect(jobs[0]).toMatchObject({ title: 'Unreal Developer', companyName: 'SAS', postedAtSource: 'source', externalId: '42981' });
    expect(jobs[0].descriptionText).toMatch(/Unreal Engine Developer/);
    expect(jobs[0].location).not.toMatch(/UNAVAILABLE/);
    expect(http.calls[0].url).toBe(SEARCH0);
  });

  it('after a run of old postings, the rest are skipped and fall outside the window', async () => {
    const { isInRange } = await import('../src/main/sources/dates');
    // 12 cards: all old → fetching stops after the streak, later cards aren't fetched.
    const row = (id: number) =>
      `<div class="row"><div class="title"><a class="iCIMS_Anchor" href="https://careers-x.icims.com/jobs/${id}/t/job?in_iframe=1"><h3>Job ${id}</h3></a></div></div>`;
    const page = `<div class="iCIMS_JobsTable">${Array.from({ length: 12 }, (_, i) => row(100 - i)).join('')}</div>`;
    const routes: Record<string, string> = { 'https://careers-x.icims.com/jobs/search?pr=0&in_iframe=1': page };
    for (let i = 0; i < 12; i++) routes[`https://careers-x.icims.com/jobs/${100 - i}/job?in_iframe=1`] = detailFor(String(100 - i), '2026-06-01T00:00:00.000Z');
    const http = fakeHttp(routes);
    const c = ctx(http, 7);
    const jobs = await icimsAdapter.listJobs(company('icims', 'careers-x', 'x', 'X'), c);
    const detailCalls = http.calls.filter((x) => x.url.includes('/job?in_iframe=1')).length;
    expect(detailCalls).toBeLessThan(12);
    expect(jobs.every((j: any) => !isInRange(j, NOW.toISOString(), c.range))).toBe(true);
  });

  it('reuses stored dates instead of refetching known postings', async () => {
    const http = fakeHttp({ [SEARCH0]: fixture('icims-search-p0.html'), 'https://globalcareers-sas.icims.com/jobs/search?pr=*': '<div class="iCIMS_JobsTable"></div>' });
    const c = { ...ctx(http, 7), lookupKnown: () => ({ postedAt: '2026-09-28T00:00:00.000Z' }) };
    const jobs = await icimsAdapter.listJobs(company('icims', 'globalcareers-sas', 'x', 'SAS'), c);
    expect(jobs.every((j: any) => j.postedAt === '2026-09-28T00:00:00.000Z')).toBe(true);
    expect(http.calls.some((x) => x.url.includes('/jobs/42981/'))).toBe(false);
  });

  it('fetchJob reads a single posting', async () => {
    const http = fakeHttp({ 'https://careers-sas.icims.com/jobs/42981/job?in_iframe=1': fixture('icims-job.html') });
    const j = await icimsAdapter.fetchJob!('https://careers-sas.icims.com/jobs/42981/unreal-developer/job?hub=9&in_iframe=1', ctx(http));
    expect(j).toMatchObject({ title: 'Unreal Developer', postedAt: '2026-09-25T04:00:00.000Z', postedAtSource: 'source', companyName: 'SAS' });
  });

  it('detects iCIMS portals from URLs and pages', async () => {
    expect(detectEmbeddedAts('<iframe src="https://careers-acme.icims.com/jobs/search?ss=1&in_iframe=1"></iframe>')).toMatchObject({ atsType: 'icims', boardToken: 'careers-acme' });
    const http = fakeHttp({});
    expect(await detectCompany('https://globalcareers-sas.icims.com/jobs/search?ss=1', http)).toMatchObject({ atsType: 'icims', boardToken: 'globalcareers-sas', suggestedName: 'Sas' });
  });
});
