import type { JobExtraction } from './llm-schemas';
import type { HardFilterKey, HardFilters } from './profile';
import { HARD_FILTER_LABELS } from './profile';
import { ANYWHERE, canonicalCountry, countriesInRegion, sameCountry } from './geo';

/**
 * Hard filters (§9): pure code, no LLM. Each rule is toggleable per profile; unknown or missing job
 * data always passes. Every failed rule yields a human-readable reason.
 */

export type HardFilterStatus = 'pass' | 'fail' | 'unknown' | 'off';

export interface HardFilterResult {
  key: HardFilterKey;
  label: string;
  status: HardFilterStatus;
  detail: string;
}

export interface HardFilterOutcome {
  pass: boolean;
  reasons: string[];
  results: HardFilterResult[];
}

export type JobFieldsForFilters = Pick<
  JobExtraction,
  | 'work_mode'
  | 'remote_region'
  | 'country'
  | 'city'
  | 'salary_min'
  | 'salary_max'
  | 'salary_currency'
  | 'salary_period'
  | 'salary_listed'
  | 'visa_sponsorship'
  | 'seniority'
  | 'employment_type'
  | 'required_languages'
>;

const UNKNOWN = new Set(['', 'unknown', 'not mentioned', 'n/a', 'none', 'other']);
const isKnown = (v: string | null | undefined): v is string => !!v && !UNKNOWN.has(v.trim().toLowerCase());
const eq = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

const PER_YEAR: Record<string, number> = { year: 1, month: 12, week: 52, day: 260, hour: 2080 };

/** Map free-form salary periods ("annual", "per hour", "monthly") onto year/month/week/day/hour. */
export function normalizePeriod(p: string | null | undefined): string | null {
  if (!p) return null;
  const v = p.toLowerCase();
  if (/year|annual|annum|\byr\b/.test(v)) return 'year';
  if (/month|\bmo\b/.test(v)) return 'month';
  if (/week|\bwk\b/.test(v)) return 'week';
  if (/hour|\bhr\b/.test(v)) return 'hour';
  if (/day|daily/.test(v)) return 'day';
  return null;
}

/** "English (fluent)" → "english". */
const langKey = (s: string) => s.replace(/\(.*?\)/g, '').trim().toLowerCase();

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Case-insensitive whole-word search ("Java" doesn't match "JavaScript"). */
export function findKeyword(text: string, keyword: string): boolean {
  const k = keyword.trim();
  if (!k) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(k)}(?![\\p{L}\\p{N}])`, 'iu').test(text);
}

function looseCityMatch(allowed: string, city: string): boolean {
  const a = allowed.trim().toLowerCase();
  const c = city.trim().toLowerCase();
  return a === c || c.startsWith(`${a} `) || c.startsWith(`${a},`) || a.startsWith(`${c} `);
}

function where(f: JobFieldsForFilters): string {
  return [f.city, f.country].filter(isKnown).join(', ');
}

export function evaluateHardFilters(
  hard: HardFilters,
  job: JobFieldsForFilters,
  jobText: string,
  seniorityOrder: readonly string[],
): HardFilterOutcome {
  const results: HardFilterResult[] = [];
  const add = (key: HardFilterKey, enabled: boolean, fn: () => [HardFilterStatus, string]) => {
    const label = HARD_FILTER_LABELS[key].label;
    if (!enabled) {
      results.push({ key, label, status: 'off', detail: 'Not used' });
      return;
    }
    const [status, detail] = fn();
    results.push({ key, label, status, detail });
  };

  add('location', hard.location.enabled, () => {
    const countries = hard.location.countries.map((c) => canonicalCountry(c)).filter((c): c is string => !!c);
    const cities = hard.location.cities.filter((c) => c.trim());
    if (!countries.length && !cities.length) return ['pass', 'No locations listed'];
    if (isKnown(job.work_mode) && eq(job.work_mode, 'Remote')) {
      const allowed = countriesInRegion(job.remote_region);
      if (!allowed) return ['pass', job.remote_region ? `Remote (${job.remote_region})` : 'Remote, no region restriction'];
      if (allowed.includes(ANYWHERE)) return ['pass', `Remote (${job.remote_region})`];
      if (allowed.some((a) => countries.some((c) => sameCountry(a, c)))) return ['pass', `Remote (${job.remote_region})`];
      if (!countries.length) return ['unknown', `Remote (${job.remote_region}); no allowed countries to compare`];
      return ['fail', `Remote only for ${job.remote_region}, which doesn't include ${countries.join(' / ')}`];
    }
    const country = isKnown(job.country) ? canonicalCountry(job.country) : null;
    const city = isKnown(job.city) ? job.city : null;
    if (!country && !city) return ['unknown', 'Job location unknown'];
    if (country && countries.some((c) => sameCountry(c, country))) return ['pass', where(job)];
    if (city && cities.some((c) => looseCityMatch(c, city))) return ['pass', where(job)];
    // Can't decide when the field we'd need is missing (e.g. only cities are listed but the job has no city).
    if (!country && !cities.length) return ['unknown', `Country unknown (${city})`];
    if (!city && !countries.length) return ['unknown', `City unknown (${country})`];
    return ['fail', `Location ${where(job)} isn't in your allowed locations`];
  });

  add('workModes', hard.workModes.enabled, () => {
    if (!isKnown(job.work_mode)) return ['unknown', 'Work mode not stated'];
    if (hard.workModes.allowed.some((m) => eq(m, job.work_mode))) return ['pass', job.work_mode];
    return ['fail', `Work mode ${job.work_mode} isn't one of ${hard.workModes.allowed.join(', ') || '(none selected)'}`];
  });

  add('visa', hard.visa.enabled, () => {
    if (!hard.visa.needsSponsorship) return ['pass', "You don't need sponsorship"];
    if (isKnown(job.visa_sponsorship) && eq(job.visa_sponsorship, 'No')) return ['fail', 'You need visa sponsorship and the job says it does not sponsor'];
    return [isKnown(job.visa_sponsorship) ? 'pass' : 'unknown', `Sponsorship: ${job.visa_sponsorship || 'not mentioned'}`];
  });

  add('salary', hard.salary.enabled, () => {
    const min = hard.salary.min;
    if (min == null) return ['pass', 'No minimum set'];
    if (!job.salary_listed || job.salary_max == null) return ['unknown', 'Salary not listed'];
    const cur = job.salary_currency?.trim().toUpperCase();
    if (!cur || cur !== hard.salary.currency.toUpperCase()) return ['unknown', `Salary in ${cur || 'unknown currency'}; can't compare with ${hard.salary.currency}`];
    const period = normalizePeriod(job.salary_period);
    if (!period) return ['unknown', 'Salary period unknown'];
    const jobYearly = job.salary_max * PER_YEAR[period];
    const minYearly = min * PER_YEAR[hard.salary.period];
    const shown = `${job.salary_max.toLocaleString('en-US')} ${cur}/${period}`;
    if (jobYearly < minYearly) return ['fail', `Salary up to ${shown} is below your minimum of ${min.toLocaleString('en-US')} ${hard.salary.currency}/${hard.salary.period}`];
    return ['pass', `Up to ${shown}`];
  });

  add('seniority', hard.seniority.enabled, () => {
    const levels = seniorityOrder.filter(isKnown);
    if (!isKnown(job.seniority)) return ['unknown', 'Seniority not stated'];
    const idx = levels.findIndex((l) => eq(l, job.seniority));
    if (idx < 0) return ['unknown', `Seniority "${job.seniority}" isn't in the taxonomy`];
    const lo = hard.seniority.min ? levels.findIndex((l) => eq(l, hard.seniority.min!)) : -1;
    const hi = hard.seniority.max ? levels.findIndex((l) => eq(l, hard.seniority.max!)) : -1;
    if (lo >= 0 && idx < lo) return ['fail', `Seniority ${job.seniority} is below your range (${hard.seniority.min}–${hard.seniority.max ?? 'any'})`];
    if (hi >= 0 && idx > hi) return ['fail', `Seniority ${job.seniority} is above your range (${hard.seniority.min ?? 'any'}–${hard.seniority.max})`];
    return ['pass', job.seniority];
  });

  add('employmentTypes', hard.employmentTypes.enabled, () => {
    if (!isKnown(job.employment_type)) return ['unknown', 'Employment type not stated'];
    if (hard.employmentTypes.allowed.some((t) => eq(t, job.employment_type))) return ['pass', job.employment_type];
    return ['fail', `Employment type ${job.employment_type} isn't one of ${hard.employmentTypes.allowed.join(', ') || '(none selected)'}`];
  });

  add('dealBreakers', hard.dealBreakers.enabled, () => {
    const hits = hard.dealBreakers.keywords.filter((k) => findKeyword(jobText, k));
    if (hits.length) return ['fail', `Contains deal-breaker ${hits.length === 1 ? 'keyword' : 'keywords'}: ${hits.join(', ')}`];
    return ['pass', hard.dealBreakers.keywords.length ? 'No deal-breakers found' : 'No keywords set'];
  });

  add('languages', hard.languages.enabled, () => {
    const spoken = new Set(hard.languages.spoken.map(langKey).filter(Boolean));
    if (!spoken.size) return ['pass', 'No languages listed'];
    const required = (job.required_languages ?? []).map((l) => l.trim()).filter(Boolean);
    if (!required.length) return ['unknown', 'No language requirements stated'];
    const missing = required.filter((l) => !spoken.has(langKey(l)));
    if (missing.length) return ['fail', `Requires ${missing.join(', ')}, which you don't speak`];
    return ['pass', `Requires ${required.join(', ')}`];
  });

  const reasons = results.filter((r) => r.status === 'fail').map((r) => r.detail);
  return { pass: reasons.length === 0, reasons, results };
}
