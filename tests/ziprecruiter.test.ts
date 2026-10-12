import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeHttp } from './fakeHttp';
import { parseZipRecruiterPage } from '../src/main/sources/ziprecruiter';
import { fetchDescription } from '../src/main/analysis/fetch';

const HTML = readFileSync(join(__dirname, 'fixtures', 'sites', 'ziprecruiter-job.html'), 'utf8');
const NOW = new Date('2026-10-12T12:00:00Z');
const LINK = 'https://ziprecruiter.com/kn/AAJ0z4qa';

describe('ZipRecruiter', () => {
  it('reads the posting header and description, not the company blurb or similar jobs', () => {
    const p = parseZipRecruiterPage(HTML)!;
    expect(p).toMatchObject({ title: 'Software Architect', companyName: 'AVUM INC', location: 'Malibu, CA · On-site', postedText: 'Posted 5 days ago' });
    expect(p.text).toContain('$130K - $180K/yr');
    expect(p.text).toContain('Position Summary');
    expect(p.text).toContain('- 8+ years of software engineering experience');
    expect(p.text).not.toContain('About AVUM');
    expect(p.text).not.toContain('AI Trainer');
    expect(p.text).not.toContain('Learn more about');
  });

  it('fetches through the browser when the plain request hits the bot check', async () => {
    const http = fakeHttp({ [LINK]: { status: 403, text: '<title>Just a moment...</title>' } });
    const render = async () => ({ html: HTML, url: 'https://www.ziprecruiter.com/jobs/v2/eyJsaXN0', status: 200 });
    const r = await fetchDescription(LINK, { http, render, now: NOW });
    expect(r).toMatchObject({ kind: 'text', via: 'browser', pageTitle: 'Software Architect', raw: { title: 'Software Architect', companyName: 'AVUM INC', postedAtSource: 'relative' } });
  });

  it('an expired link that lands on the search page is closed', async () => {
    const http = fakeHttp({ [LINK]: { status: 403, text: '<title>Just a moment...</title>' } });
    const render = async () => ({ html: '<title>Just a moment...</title>', url: 'https://www.ziprecruiter.com/jobs-search?lk=x', status: 403 });
    expect(await fetchDescription(LINK, { http, render, now: NOW })).toMatchObject({ kind: 'closed' });
  });
});
