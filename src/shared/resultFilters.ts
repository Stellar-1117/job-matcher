import type { ResultFields, ResultRow, JobStatus } from './results';
import type { Verdict } from './scoring';
import { TAXONOMY_LABELS } from './taxonomy';
import { normalizePeriod } from './hardFilters';

/** Filter sidebar of the Results screen (§12). Pure functions so they can be unit-tested. */

export const FACETS = [
  { key: 'job_function', label: TAXONOMY_LABELS.job_function, list: false },
  { key: 'seniority', label: TAXONOMY_LABELS.seniority, list: false },
  { key: 'work_mode', label: TAXONOMY_LABELS.work_mode, list: false },
  { key: 'employment_type', label: TAXONOMY_LABELS.employment_type, list: false },
  { key: 'industry', label: TAXONOMY_LABELS.industry, list: false },
  { key: 'company_stage', label: TAXONOMY_LABELS.company_stage, list: false },
  { key: 'visa_sponsorship', label: TAXONOMY_LABELS.visa_sponsorship, list: false },
  { key: 'country', label: 'Country', list: false },
  { key: 'remote_region', label: 'Remote region', list: false },
  { key: 'required_languages', label: 'Required languages', list: true },
  { key: 'tech_stack', label: 'Tech stack', list: true },
  { key: 'must_have_skills', label: 'Must-have skills', list: true },
  { key: 'nice_to_have_skills', label: 'Nice-to-have skills', list: true },
  { key: 'problem_domains', label: 'Problem domains', list: true },
] as const satisfies readonly { key: keyof ResultFields; label: string; list: boolean }[];
export type FacetKey = (typeof FACETS)[number]['key'];

export type DateFilterPreset = 'any' | 'today' | 'last7' | 'last30' | 'custom';

export interface ResultFilters {
  search: string;
  minScore: number;
  /** Empty = all verdicts. */
  verdicts: Verdict[];
  /** Empty = all statuses. */
  statuses: JobStatus[];
  hideReviewedRejected: boolean;
  hideClosed: boolean;
  showHardFiltered: boolean;
  date: { preset: DateFilterPreset; from: string | null; to: string | null };
  /** Empty = all sources. */
  sources: string[];
  /** Within a facet any value matches; across facets all must match. */
  facets: Partial<Record<FacetKey, string[]>>;
  salaryListedOnly: boolean;
  /** Minimum yearly salary (the listed maximum, converted to per-year), optionally in one currency. */
  minSalary: number | null;
  salaryCurrency: string | null;
  /** Jobs requiring at most this many years. */
  maxYears: number | null;
}

export const DEFAULT_FILTERS: ResultFilters = {
  search: '',
  minScore: 0,
  verdicts: [],
  statuses: [],
  hideReviewedRejected: false,
  hideClosed: true,
  showHardFiltered: false,
  date: { preset: 'any', from: null, to: null },
  sources: [],
  facets: {},
  salaryListedOnly: false,
  minSalary: null,
  salaryCurrency: null,
  maxYears: null,
};

export interface ScoredRow extends ResultRow {
  total: number | null;
  verdict: Verdict | null;
}

const UNKNOWN_VALUE = 'Unknown';

/** A row's values for a facet; missing values count as "Unknown" so they can be filtered too. */
export function facetValues(row: Pick<ResultRow, 'fields'>, key: FacetKey): string[] {
  const v = row.fields?.[key];
  if (Array.isArray(v)) return v.length ? v : [];
  if (typeof v === 'string' && v.trim()) return [v];
  return [UNKNOWN_VALUE];
}

export function facetCounts(rows: Pick<ResultRow, 'fields'>[], key: FacetKey): { value: string; count: number }[] {
  const counts = new Map<string, { value: string; count: number }>();
  for (const r of rows) {
    for (const v of new Set(facetValues(r, key))) {
      const k = v.toLowerCase();
      const e = counts.get(k) ?? { value: v, count: 0 };
      e.count++;
      counts.set(k, e);
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

const PER_YEAR: Record<string, number> = { year: 1, month: 12, week: 52, day: 260, hour: 2080 };

/** The listed salary's top end per year (max, else min), or null when not listed / period unknown. */
export function yearlySalary(f: ResultFields | null): number | null {
  if (!f?.salary_listed) return null;
  const top = f.salary_max ?? f.salary_min;
  const period = normalizePeriod(f.salary_period) ?? (top != null && top > 1000 ? 'year' : null);
  if (top == null || !period) return null;
  return top * PER_YEAR[period];
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function dateBounds(f: ResultFilters['date'], now: Date): { from: number; to: number } | null {
  const DAY = 86_400_000;
  switch (f.preset) {
    case 'any':
      return null;
    case 'today':
      return { from: startOfDay(now).getTime(), to: Infinity };
    case 'last7':
      return { from: startOfDay(new Date(now.getTime() - 7 * DAY)).getTime(), to: Infinity };
    case 'last30':
      return { from: startOfDay(new Date(now.getTime() - 30 * DAY)).getTime(), to: Infinity };
    case 'custom': {
      const p = (s: string | null) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.split('-').map(Number) : null);
      const a = p(f.from);
      const b = p(f.to);
      return {
        from: a ? new Date(a[0], a[1] - 1, a[2]).getTime() : -Infinity,
        to: b ? new Date(b[0], b[1] - 1, b[2], 23, 59, 59, 999).getTime() : Infinity,
      };
    }
  }
}

export function applyFilters(rows: ScoredRow[], f: ResultFilters, now = new Date()): ScoredRow[] {
  const q = f.search.trim().toLowerCase();
  const bounds = dateBounds(f.date, now);
  const sources = new Set(f.sources);
  const verdicts = new Set(f.verdicts);
  const statuses = new Set(f.statuses);
  const facets = (Object.entries(f.facets) as [FacetKey, string[]][]).filter(([, v]) => v?.length).map(([k, v]) => [k, new Set(v.map((x) => x.toLowerCase()))] as const);

  return rows.filter((r) => {
    if (!f.showHardFiltered && !r.hardFilterPass) return false;
    if (f.hideClosed && r.isClosed) return false;
    if (f.hideReviewedRejected && (r.status === 'reviewed' || r.status === 'rejected')) return false;
    if (statuses.size && !statuses.has(r.status)) return false;
    if (verdicts.size && (!r.verdict || !verdicts.has(r.verdict))) return false;
    if (f.minScore > 0 && (r.total == null || r.total < f.minScore)) return false;
    if (sources.size && !sources.has(r.sourceKey)) return false;
    if (bounds) {
      const t = Date.parse(r.postedAt ?? r.firstSeenAt);
      if (!(t >= bounds.from && t <= bounds.to)) return false;
    }
    for (const [key, wanted] of facets) {
      if (!facetValues(r, key).some((v) => wanted.has(v.toLowerCase()))) return false;
    }
    if (f.salaryListedOnly && !r.fields?.salary_listed) return false;
    if (f.minSalary != null) {
      const y = yearlySalary(r.fields);
      if (y == null || y < f.minSalary) return false;
      if (f.salaryCurrency && r.fields?.salary_currency?.toUpperCase() !== f.salaryCurrency.toUpperCase()) return false;
    }
    if (f.maxYears != null && r.fields?.required_years != null && r.fields.required_years > f.maxYears) return false;
    if (q && ![r.title, r.companyName, r.location, r.summary, r.url].some((v) => v?.toLowerCase().includes(q))) return false;
    return true;
  });
}

/** Number of active filters, for the "Clear filters" button. */
export function activeFilterCount(f: ResultFilters): number {
  let n = 0;
  if (f.search.trim()) n++;
  if (f.minScore > 0) n++;
  if (f.verdicts.length) n++;
  if (f.statuses.length) n++;
  if (f.hideReviewedRejected) n++;
  if (!f.hideClosed) n++;
  if (f.showHardFiltered) n++;
  if (f.date.preset !== 'any') n++;
  if (f.sources.length) n++;
  n += Object.values(f.facets).filter((v) => v?.length).length;
  if (f.salaryListedOnly) n++;
  if (f.minSalary != null) n++;
  if (f.maxYears != null) n++;
  return n;
}
