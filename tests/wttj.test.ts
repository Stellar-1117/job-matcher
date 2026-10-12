import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb } from './helpers';

vi.mock('../src/main/sources/wttj', () => ({ readWttjMatches: vi.fn() }));

const { wttjJobUrls, isWttjListingPage, wttjJobUrlsFromJson, isWttjMatchesApi } = await import('../src/main/sources/wttjLinks');
const { addCompany } = await import('../src/main/repos/companies');
const { addLinks, getJobItem } = await import('../src/main/repos/jobs');
const { saveWttjMatches, wttjState } = await import('../src/main/runs/wttj');

const JOB_A = 'https://www.welcometothejungle.com/en/companies/doctolib/jobs/senior-backend-engineer_paris';
const JOB_B = 'https://www.welcometothejungle.com/en/companies/alan/jobs/staff-software-engineer_remote';

beforeEach(() => setupTestDb());

describe('Welcome to the Jungle links', () => {
  it('keeps only job posting links from a page, without query strings, once each', () => {
    expect(
      wttjJobUrls([
        `${JOB_A}?q=abc&o=123`,
        '/en/companies/alan/jobs/staff-software-engineer_remote',
        'https://www.welcometothejungle.com/en/companies/alan',
        'https://www.welcometothejungle.com/en/jobs-matches',
        JOB_A,
        'https://example.com/en/companies/x/jobs/y',
      ]),
    ).toEqual([JOB_A, JOB_B]);
  });

  it('recognizes list pages', () => {
    expect(isWttjListingPage('https://welcometothejungle.com/en/jobs-matches')).toBe(true);
    expect(isWttjListingPage('https://welcometothejungle.com/en/companies/alan/jobs')).toBe(true);
    expect(isWttjListingPage('https://welcometothejungle.com/en/companies/alan/jobs/staff-software-engineer_remote')).toBe(false);
  });

  it('refuses the matches page as a job link and takes title and company from job links', () => {
    const r = addLinks(`https://www.welcometothejungle.com/en/jobs-matches\n${JOB_A}`);
    expect(r.invalid).toEqual([{ input: 'https://www.welcometothejungle.com/en/jobs-matches', reason: expect.stringMatching(/not a job/) }]);
    expect(r.added[0]).toMatchObject({ title: 'Senior Backend Engineer', companyName: 'Doctolib', sourceLabel: 'Welcome to the Jungle' });
  });
});

describe('Welcome to the Jungle API responses', () => {
  it('builds job links from job objects in the JSON the Matches page loads', () => {
    const body = {
      jobs: [
        { name: 'Senior Backend Engineer', slug: 'senior-backend-engineer_paris', reference: 'abc', organization: { name: 'Doctolib', slug: 'doctolib' } },
        { name: 'Staff Software Engineer', slug: 'staff-software-engineer_remote', organization: { slug: 'alan' } },
        { name: 'No org', slug: 'orphan' },
      ],
      meta: { page: 1, organization: { slug: 'not-a-job' } },
    };
    expect(wttjJobUrlsFromJson(body)).toEqual([JOB_A, JOB_B]);
  });

  it('only listens to matches / job search API calls', () => {
    expect(isWttjMatchesApi('https://www.welcometothejungle.com/api/v3/search/jobs?page=1')).toBe(true);
    expect(isWttjMatchesApi('https://www.welcometothejungle.com/api/v3/jobs-matches?page=2')).toBe(true);
    expect(isWttjMatchesApi('https://www.welcometothejungle.com/api/v3/jobs-matches/counts')).toBe(false);
    expect(isWttjMatchesApi('https://www.welcometothejungle.com/en/jobs-matches')).toBe(false);
  });

  it('refuses the Matches page as a company careers site', () => {
    expect(() => addCompany({ name: 'WTTJ', careersUrl: 'https://www.welcometothejungle.com/en/jobs-matches', atsType: 'generic', boardToken: null })).toThrow(/Welcome to the Jungle matches/);
  });
});

describe('importing matches', () => {
  it('saves new matches and marks the ones the app already had', () => {
    const [existing] = addLinks(JOB_A).added;
    const imp = saveWttjMatches([JOB_A, JOB_B], new Date('2026-10-12T09:00:00Z'));
    expect(imp.matches).toEqual([
      expect.objectContaining({ url: 'https://welcometothejungle.com/en/companies/doctolib/jobs/senior-backend-engineer_paris', jobId: existing.id, status: 'already_saved' }),
      expect.objectContaining({ url: 'https://welcometothejungle.com/en/companies/alan/jobs/staff-software-engineer_remote', status: 'new', title: 'Staff Software Engineer' }),
    ]);
    expect(getJobItem(imp.matches[1].jobId!)).not.toBeNull();

    // The next import marks both as already saved; the state keeps the last import.
    const again = saveWttjMatches([JOB_A, JOB_B]);
    expect(again.matches.map((m) => m.status)).toEqual(['already_saved', 'already_saved']);
    expect(wttjState()).toMatchObject({ importing: false, lastImport: { importedAt: again.importedAt } });
  });
});

describe('bookmarklet', () => {
  it('is valid JavaScript and finds the same links as the app', async () => {
    const { WTTJ_BOOKMARKLET, WTTJ_BOOKMARKLET_SOURCE } = await import('../src/shared/wttj');
    expect(() => new Function(WTTJ_BOOKMARKLET_SOURCE)).not.toThrow();
    expect(() => new Function(decodeURIComponent(WTTJ_BOOKMARKLET.slice('javascript:'.length)))).not.toThrow();
    const re = new RegExp(WTTJ_BOOKMARKLET_SOURCE.match(/const re = \/(.+)\/;/)![1]);
    expect(`${JOB_A}?q=1`.match(re)?.[0]).toBe(JOB_A);
    expect('https://www.welcometothejungle.com/en/jobs-matches'.match(re)).toBeNull();
  });

  it('imports pasted links and marks the ones already saved', async () => {
    const { importWttjLinks } = await import('../src/main/runs/wttj');
    addLinks(JOB_A);
    const imp = importWttjLinks(`${JOB_A}\n${JOB_B}\nhttps://example.com/x`);
    expect(imp.matches.map((m) => m.status)).toEqual(['already_saved', 'new']);
    expect(() => importWttjLinks('nothing here')).toThrow(/No Welcome to the Jungle job links/);
  });
});
