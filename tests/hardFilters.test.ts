import { describe, expect, it } from 'vitest';
import { evaluateHardFilters, findKeyword, normalizePeriod, type JobFieldsForFilters } from '../src/shared/hardFilters';
import { DEFAULT_PREFERENCES, type HardFilters } from '../src/shared/profile';
import { DEFAULT_TAXONOMY } from '../src/shared/taxonomy';
import { canonicalCountry, countriesInRegion } from '../src/shared/geo';
import { canonicalTech, normalizeTechList } from '../src/shared/tech';

const job = (over: Partial<JobFieldsForFilters> = {}): JobFieldsForFilters => ({
  work_mode: 'Onsite',
  remote_region: null,
  country: 'United States',
  city: 'New York',
  salary_min: null,
  salary_max: null,
  salary_currency: null,
  salary_period: null,
  salary_listed: false,
  visa_sponsorship: 'Not mentioned',
  seniority: 'Senior',
  employment_type: 'Full-time',
  required_languages: [],
  ...over,
});

/** Default (all off) hard filters with some turned on. */
const filters = (over: { [K in keyof HardFilters]?: Partial<HardFilters[K]> }): HardFilters => {
  const out = structuredClone(DEFAULT_PREFERENCES.hard) as any;
  for (const [k, v] of Object.entries(over)) out[k] = { ...out[k], enabled: true, ...v };
  return out;
};

const run = (h: HardFilters, j = job(), text = 'A job') => evaluateHardFilters(h, j, text, DEFAULT_TAXONOMY.seniority);

describe('hard filters', () => {
  it('passes everything when no filter is enabled', () => {
    const r = run(DEFAULT_PREFERENCES.hard);
    expect(r.pass).toBe(true);
    expect(r.results.every((x) => x.status === 'off')).toBe(true);
  });

  it('never rejects on missing job data', () => {
    const h = filters({
      location: { countries: ['Germany'] },
      workModes: { allowed: ['Remote'] },
      visa: { needsSponsorship: true },
      salary: { min: 100000, currency: 'USD', period: 'year' },
      seniority: { min: 'Mid', max: 'Senior' },
      employmentTypes: { allowed: ['Full-time'] },
      languages: { spoken: ['English'] },
    });
    const unknown = job({ work_mode: 'Unknown', country: null, city: null, visa_sponsorship: 'Not mentioned', seniority: 'Unknown', employment_type: 'Unknown' });
    const r = run(h, unknown);
    expect(r.pass).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  describe('location', () => {
    const h = filters({ location: { countries: ['USA'], cities: ['Toronto'] } });
    it('matches countries through aliases and cities loosely', () => {
      expect(run(h, job({ country: 'United States' })).pass).toBe(true);
      expect(run(h, job({ country: 'Canada', city: 'Toronto' })).pass).toBe(true);
      expect(run(h, job({ country: 'Canada', city: 'Toronto, ON' })).pass).toBe(true);
      const r = run(h, job({ country: 'France', city: 'Paris' }));
      expect(r.pass).toBe(false);
      expect(r.reasons[0]).toMatch(/Paris, France/);
    });
    it('lets remote jobs through unless their region excludes you', () => {
      const de = filters({ location: { countries: ['Germany'] } });
      expect(run(de, job({ work_mode: 'Remote', country: 'United States', remote_region: null })).pass).toBe(true);
      expect(run(de, job({ work_mode: 'Remote', remote_region: 'EU time zones' })).pass).toBe(true);
      expect(run(de, job({ work_mode: 'Remote', remote_region: 'Worldwide' })).pass).toBe(true);
      expect(run(de, job({ work_mode: 'Remote', remote_region: 'Must overlap with our team' })).pass).toBe(true); // unrecognised → pass
      const us = run(de, job({ work_mode: 'Remote', remote_region: 'US only' }));
      expect(us.pass).toBe(false);
      expect(us.reasons[0]).toMatch(/Remote only for US only/);
    });
  });

  it('work mode, visa, employment type', () => {
    expect(run(filters({ workModes: { allowed: ['Remote', 'Hybrid'] } })).reasons[0]).toMatch(/Work mode Onsite/);
    expect(run(filters({ visa: { needsSponsorship: true } }), job({ visa_sponsorship: 'No' })).pass).toBe(false);
    expect(run(filters({ visa: { needsSponsorship: false } }), job({ visa_sponsorship: 'No' })).pass).toBe(true);
    expect(run(filters({ employmentTypes: { allowed: ['Full-time'] } }), job({ employment_type: 'Contract' })).pass).toBe(false);
  });

  it('salary compares the listed maximum, converting the period only when currency matches', () => {
    const h = filters({ salary: { min: 120000, currency: 'USD', period: 'year' } });
    expect(run(h, job({ salary_listed: true, salary_min: 90000, salary_max: 110000, salary_currency: 'USD', salary_period: 'year' })).pass).toBe(false);
    expect(run(h, job({ salary_listed: true, salary_max: 130000, salary_currency: 'USD', salary_period: 'year' })).pass).toBe(true);
    // $50/h × 2080 = $104k < $120k
    expect(run(h, job({ salary_listed: true, salary_max: 50, salary_currency: 'USD', salary_period: 'per hour' })).pass).toBe(false);
    expect(run(h, job({ salary_listed: true, salary_max: 70, salary_currency: 'USD', salary_period: 'hourly' })).pass).toBe(true);
    // Different currency or unknown period: can't compare → pass.
    expect(run(h, job({ salary_listed: true, salary_max: 50000, salary_currency: 'EUR', salary_period: 'year' })).pass).toBe(true);
    expect(run(h, job({ salary_listed: true, salary_max: 50000, salary_currency: 'USD', salary_period: null })).pass).toBe(true);
    expect(run(h, job({ salary_listed: false })).pass).toBe(true);
  });

  it('seniority range follows the taxonomy order', () => {
    const h = filters({ seniority: { min: 'Mid', max: 'Staff/Principal' } });
    expect(run(h, job({ seniority: 'Senior' })).pass).toBe(true);
    expect(run(h, job({ seniority: 'Entry' })).reasons[0]).toMatch(/below your range/);
    expect(run(h, job({ seniority: 'Director+' })).reasons[0]).toMatch(/above your range/);
    expect(run(filters({ seniority: { min: 'Senior', max: null } }), job({ seniority: 'Director+' })).pass).toBe(true);
  });

  it('deal-breakers match whole words only', () => {
    const h = filters({ dealBreakers: { keywords: ['Java', 'on-call'] } });
    expect(run(h, job(), 'We use JavaScript and TypeScript').pass).toBe(true);
    const r = run(h, job(), 'Stack: Java 21. Weekly on-call rotation.');
    expect(r.pass).toBe(false);
    expect(r.reasons[0]).toBe('Contains deal-breaker keywords: Java, on-call');
    expect(findKeyword('C++ developer', 'C++')).toBe(true);
  });

  it('required languages the person does not speak', () => {
    const h = filters({ languages: { spoken: ['English', 'Spanish (native)'] } });
    expect(run(h, job({ required_languages: ['English', 'spanish'] })).pass).toBe(true);
    const r = run(h, job({ required_languages: ['English', 'German'] }));
    expect(r.pass).toBe(false);
    expect(r.reasons[0]).toMatch(/Requires German/);
  });

  it('records every failed rule', () => {
    const h = filters({ workModes: { allowed: ['Remote'] }, employmentTypes: { allowed: ['Full-time'] } });
    const r = run(h, job({ work_mode: 'Onsite', employment_type: 'Contract' }));
    expect(r.reasons).toHaveLength(2);
  });
});

describe('normalisation helpers', () => {
  it('countries, regions, periods and tech names', () => {
    expect(canonicalCountry('USA')).toBe('United States');
    expect(canonicalCountry('germany')).toBe('Germany');
    expect(countriesInRegion('US or Canada')).toEqual(expect.arrayContaining(['United States', 'Canada']));
    expect(countriesInRegion('Remote - anywhere')).toEqual(['*']);
    expect(countriesInRegion('Only people who use us')).toBeNull(); // lower-case "us" is a word, not a country
    expect(normalizePeriod('Annual')).toBe('year');
    expect(normalizePeriod('per hour')).toBe('hour');
    expect(canonicalTech('JS')).toBe('JavaScript');
    expect(normalizeTechList(['golang', 'Go', 'k8s', 'Postgres', 'Elixir'])).toEqual(['Go', 'Kubernetes', 'PostgreSQL', 'Elixir']);
  });
});
