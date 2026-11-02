import { beforeEach, describe, expect, it } from 'vitest';
import { normalizeUrl, splitLinkInput } from '../src/main/sources/url';
import { detectAts, hintsFromUrl, prettifyToken } from '../src/main/sources/detect';
import { sourceLabel } from '@shared/jobs';
import { setupTestDb } from './helpers';
import { addLinks, deleteJobs, listJobs } from '../src/main/repos/jobs';
import { addDescription, markUnreadable, refetchJobs, saveFetchedText, savePastedText } from '../src/main/repos/analysis';

const norm = (s: string) => {
  const r = normalizeUrl(s);
  if (!r.ok) throw new Error(r.reason);
  return r.url;
};

describe('normalizeUrl', () => {
  it('strips tracking params, fragments, www and trailing slashes', () => {
    expect(norm('https://www.example.com/careers/job/123/?utm_source=x&utm_medium=y&ref=abc#apply')).toBe('https://example.com/careers/job/123');
    expect(norm('http://Example.com/a?gclid=1&fbclid=2&trk=3')).toBe('https://example.com/a');
  });

  it('keeps meaningful params, sorted', () => {
    expect(norm('https://acme.com/careers?gh_jid=4567&utm_campaign=z&dept=eng')).toBe('https://acme.com/careers?dept=eng&gh_jid=4567');
  });

  it('adds https to bare domains and trims surrounding punctuation', () => {
    expect(norm('jobs.lever.co/acme/abc-123')).toBe('https://jobs.lever.co/acme/abc-123');
    expect(norm('<https://acme.com/job/1>')).toBe('https://acme.com/job/1');
    expect(norm('https://acme.com/job/1).')).toBe('https://acme.com/job/1');
  });

  it('rejects non-URLs', () => {
    expect(normalizeUrl('hello').ok).toBe(false);
    expect(normalizeUrl('ftp://acme.com/x').ok).toBe(false);
    expect(normalizeUrl('http://localhost/x').ok).toBe(false);
  });

  it('canonicalizes LinkedIn job URLs to /jobs/view/<id>', () => {
    const id = 'https://linkedin.com/jobs/view/3812345678';
    expect(norm('https://www.linkedin.com/jobs/view/3812345678/?refId=abc&trackingId=xyz')).toBe(id);
    expect(norm('https://uk.linkedin.com/jobs/view/senior-engineer-at-acme-3812345678')).toBe(id);
    expect(norm('https://www.linkedin.com/jobs/search/?currentJobId=3812345678&keywords=go')).toBe(id);
  });

  it('canonicalizes Greenhouse, Lever, Ashby and Workday variants', () => {
    expect(norm('https://boards.greenhouse.io/stripe/jobs/5551234?gh_src=abc')).toBe('https://job-boards.greenhouse.io/stripe/jobs/5551234');
    expect(norm('https://job-boards.greenhouse.io/stripe/jobs/5551234')).toBe('https://job-boards.greenhouse.io/stripe/jobs/5551234');
    expect(norm('https://boards.greenhouse.io/embed/job_app?for=stripe&token=5551234')).toBe('https://job-boards.greenhouse.io/stripe/jobs/5551234');
    expect(norm('https://jobs.lever.co/acme/1111-2222/apply?lever-source=LinkedIn')).toBe('https://jobs.lever.co/acme/1111-2222');
    expect(norm('https://jobs.ashbyhq.com/acme/uuid-1/application?utm_source=x')).toBe('https://jobs.ashbyhq.com/acme/uuid-1');
    expect(norm('https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Engineer_JR1990001/apply?source=LinkedIn')).toBe(
      'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Engineer_JR1990001',
    );
  });

  it('canonicalizes Indeed to viewjob?jk=', () => {
    expect(norm('https://uk.indeed.com/rc/clk?jk=abc123&from=serp')).toBe('https://indeed.com/viewjob?jk=abc123');
  });
});

describe('splitLinkInput', () => {
  it('splits on newlines, spaces and commas', () => {
    expect(splitLinkInput('a.com/1\n\n  b.com/2 , c.com/3\r\n')).toEqual(['a.com/1', 'b.com/2', 'c.com/3']);
  });
});

describe('detectAts', () => {
  it('detects each ATS with board token and job id', () => {
    expect(detectAts('https://job-boards.greenhouse.io/stripe/jobs/5551234')).toEqual({ ats: 'greenhouse', boardToken: 'stripe', jobId: '5551234' });
    expect(detectAts('https://boards.greenhouse.io/stripe')).toEqual({ ats: 'greenhouse', boardToken: 'stripe', jobId: null });
    expect(detectAts('https://jobs.lever.co/acme/1111-2222')).toEqual({ ats: 'lever', boardToken: 'acme', jobId: '1111-2222' });
    expect(detectAts('https://jobs.ashbyhq.com/Acme%20Labs')).toEqual({ ats: 'ashby', boardToken: 'Acme Labs', jobId: null });
    expect(detectAts('https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/US-CA/Engineer_JR1990001')).toEqual({
      ats: 'workday',
      boardToken: 'nvidia/NVIDIAExternalCareerSite',
      jobId: 'JR1990001',
    });
    expect(detectAts('https://example.com/careers')).toBeNull();
  });

  it('derives company and title hints', () => {
    expect(prettifyToken('acme-corp_labs')).toBe('Acme Corp Labs');
    expect(hintsFromUrl('https://jobs.lever.co/acme-corp/1')).toEqual({ sourceKey: 'lever', companyName: 'Acme Corp', title: null });
    expect(hintsFromUrl('https://linkedin.com/jobs/view/3812345678', 'https://www.linkedin.com/jobs/view/senior-go-engineer-at-acme-pay-3812345678')).toEqual({
      sourceKey: 'manual:linkedin.com',
      companyName: 'Acme Pay',
      title: 'Senior Go Engineer',
    });
    expect(hintsFromUrl('https://jobright.ai/jobs/info/abc').sourceKey).toBe('manual:jobright.ai');
  });

  it('labels sources', () => {
    expect(sourceLabel('greenhouse')).toBe('Greenhouse');
    expect(sourceLabel('manual:linkedin.com')).toBe('LinkedIn');
    expect(sourceLabel('manual:jobright.ai')).toBe('Jobright');
    expect(sourceLabel('manual:careers.acme.com')).toBe('careers.acme.com');
  });
});

describe('addLinks (acceptance: 20 links with duplicates and tracking params)', () => {
  beforeEach(() => setupTestDb());

  it('stores only unique canonical jobs', () => {
    const base = [
      'https://boards.greenhouse.io/stripe/jobs/1001',
      'https://jobs.lever.co/acme/aaaa-1111',
      'https://jobs.ashbyhq.com/notion/bbbb-2222',
      'https://www.linkedin.com/jobs/view/3800000001',
      'https://jobright.ai/jobs/info/66aa01',
      'https://www.welcometothejungle.com/en/companies/doctolib/jobs/backend-engineer',
      'https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/US-CA/Engineer_JR1',
      'https://careers.acme.com/jobs/42',
    ];
    const noisy = [
      'https://boards.greenhouse.io/stripe/jobs/1001?gh_src=li&utm_source=x',
      'https://job-boards.greenhouse.io/stripe/jobs/1001/',
      'https://jobs.lever.co/acme/aaaa-1111/apply',
      'https://jobs.ashbyhq.com/notion/bbbb-2222?utm_campaign=q4',
      'https://uk.linkedin.com/jobs/view/backend-engineer-at-foo-3800000001?trk=abc',
      'https://www.linkedin.com/jobs/search/?currentJobId=3800000001',
      'jobright.ai/jobs/info/66aa01?utm_medium=share',
      'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/US-CA/Engineer_JR1/apply',
      'https://careers.acme.com/jobs/42#top',
      'https://careers.acme.com/jobs/42?ref=newsletter',
      'not a link',
      'https://careers.acme.com/jobs/42/',
    ];
    const r = addLinks([...base, ...noisy].join('\n'));
    expect(base.length + noisy.length).toBe(20);
    expect(r.added).toHaveLength(8);
    expect(r.invalid.map((i) => i.input)).toEqual(['not', 'a', 'link']);
    expect(r.duplicates).toHaveLength(11);
    expect(r.duplicates.every((d) => d.jobId != null)).toBe(true);
    expect(listJobs()).toHaveLength(8);

    // Pasting again adds nothing.
    const again = addLinks(noisy.join('\n'));
    expect(again.added).toHaveLength(0);
    expect(again.duplicates.filter((d) => d.reason === 'already_saved').length).toBeGreaterThan(0);
    expect(listJobs()).toHaveLength(8);
  });

  it('records source, company hints and first-seen date', () => {
    const r = addLinks('https://jobs.lever.co/acme-corp/x1\nhttps://jobright.ai/jobs/info/1');
    const lever = r.added.find((j) => j.sourceKey === 'lever')!;
    expect(lever).toMatchObject({ sourceLabel: 'Lever', companyName: 'Acme Corp', fetchStatus: 'pending', postedAt: null, postedAtSource: 'first_seen' });
    expect(Date.parse(lever.firstSeenAt)).not.toBeNaN();
    expect(r.added.find((j) => j.sourceKey === 'manual:jobright.ai')!.sourceLabel).toBe('Jobright');
  });

  it('deletes jobs', () => {
    const r = addLinks('https://a.com/j/1\nhttps://b.com/j/2');
    expect(deleteJobs([r.added[0].id])).toBe(1);
    expect(listJobs().map((j) => j.url)).toEqual(['https://b.com/j/2']);
  });
});

describe('iCIMS URLs', () => {
  it('canonicalizes to /jobs/{id}/job and detects the tenant', () => {
    expect(norm('https://careers-sas.icims.com/jobs/42981/unreal-developer/job?hub=9&in_iframe=1')).toBe('https://careers-sas.icims.com/jobs/42981/job');
    expect(norm('careers-sas.icims.com/jobs/42981/job?mode=apply&apply=yes')).toBe('https://careers-sas.icims.com/jobs/42981/job');
    expect(detectAts('https://careers-sas.icims.com/jobs/42981/job')).toEqual({ ats: 'icims', boardToken: 'careers-sas', jobId: '42981' });
    expect(detectAts('https://www.icims.com/about')).toBeNull();
    expect(hintsFromUrl('https://careers-acme-corp.icims.com/jobs/1/job')).toEqual({ sourceKey: 'icims', companyName: 'Acme Corp', title: null });
    expect(sourceLabel('icims')).toBe('iCIMS');
  });
});

describe('latest paste', () => {
  beforeEach(() => setupTestDb());
  const A = 'https://acme.com/careers/jobs/1';
  const B = 'https://acme.com/careers/jobs/2';
  const C = 'https://acme.com/careers/jobs/3';
  const byUrl = () => new Map(listJobs().map((j) => [j.url, j]));

  it('marks every link of a paste — new ones and ones already saved — so the batch can be analyzed for another profile', async () => {
    addLinks(`${A}\n${B}`);
    await new Promise((r) => setTimeout(r, 5));
    const second = addLinks(`${B}\n${C}\n${C}`);
    expect(second.added).toHaveLength(1);
    const jobs = byUrl();
    const latest = jobs.get(C)!.lastAddedAt;
    expect(jobs.get(B)!.lastAddedAt).toBe(latest); // already saved, re-pasted: part of the batch
    expect(jobs.get(B)!.firstSeenAt < latest!).toBe(true); // → shown as "added again"
    expect(jobs.get(C)!.firstSeenAt).toBe(latest); // → shown as "new"
    expect(jobs.get(A)!.lastAddedAt! < latest!).toBe(true); // earlier paste only
  });
});

describe('has_description flag', () => {
  beforeEach(() => setupTestDb());

  it('follows every write to the description', () => {
    const [job] = addLinks('https://acme.com/careers/jobs/1').added;
    const flag = () => listJobs()[0].hasDescription;
    expect(flag()).toBe(false);
    saveFetchedText(job.id, 'A real description');
    expect(flag()).toBe(true);
    refetchJobs([job.id]);
    expect(flag()).toBe(false);
    savePastedText(job.id, '   ');
    expect(flag()).toBe(false); // whitespace only
    savePastedText(job.id, 'Pasted text');
    expect(flag()).toBe(true);
    markUnreadable(job.id, job.url!, 'blocked');
    expect(flag()).toBe(false);
  });
});

describe('addDescription', () => {
  beforeEach(() => setupTestDb());
  const TEXT = 'Senior Backend Engineer\nAcme is hiring a backend engineer to build payment APIs in Go. Remote in the US, 5+ years of experience.';

  it('saves a description without a link, once per text', () => {
    const first = addDescription(TEXT, null);
    expect(first.duplicate).toBe(false);
    expect(first.job).toMatchObject({ url: null, sourceKey: 'description', sourceLabel: 'Pasted description', fetchStatus: 'manual_text', hasDescription: true, title: 'Senior Backend Engineer' });
    // Same text with different spacing/case is the same job.
    const again = addDescription(`  ${TEXT.toUpperCase().replace(/ /g, '  ')} `, null);
    expect(again).toMatchObject({ duplicate: true, job: { id: first.job.id } });
    expect(listJobs()).toHaveLength(1);
    expect(listJobs(true).map((j) => j.id)).toEqual([first.job.id]);
  });

  it('with a link, saves the link with the text as its description (no fetch needed)', () => {
    const { job } = addDescription(TEXT, 'https://www.linkedin.com/jobs/view/3812345678/?trk=x');
    expect(job).toMatchObject({ url: 'https://linkedin.com/jobs/view/3812345678', fetchStatus: 'manual_text', hasDescription: true });
    // An already saved link gets the description instead of a second job.
    const [saved] = addLinks('https://acme.com/careers/jobs/9').added;
    const r = addDescription(TEXT, 'https://acme.com/careers/jobs/9');
    expect(r).toMatchObject({ duplicate: true, job: { id: saved.id, fetchStatus: 'manual_text' } });
    expect(() => addDescription(TEXT, 'not a link')).toThrow(/isn't valid/);
  });
});
