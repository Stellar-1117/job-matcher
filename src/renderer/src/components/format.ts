import type { ResultFields } from '@shared/results';
import type { Verdict } from '@shared/scoring';
import { normalizePeriod } from '@shared/hardFilters';

/** Display helpers shared by the Analyze, Results and Usage screens. */

/** "$0.42"; sub-cent amounts keep 4 decimals so tiny LLM costs don't show as $0.00. */
export const usd = (n: number) => (n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

export const VERDICT_TONES: Record<Verdict, 'green' | 'blue' | 'amber' | 'slate'> = { strong: 'green', good: 'blue', stretch: 'amber', skip: 'slate' };

const PERIOD_SHORT: Record<string, string> = { year: 'yr', month: 'mo', week: 'wk', day: 'day', hour: 'hr' };

function money(n: number, currency: string | null): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: currency ? 'currency' : 'decimal',
      currency: currency ?? undefined,
      notation: n >= 10_000 ? 'compact' : 'standard',
      maximumFractionDigits: n >= 10_000 ? 1 : 2,
    }).format(n);
  } catch {
    return `${n.toLocaleString()} ${currency ?? ''}`.trim();
  }
}

/** "$120K–$160K/yr", or "Not listed". */
export function formatSalary(f: Pick<ResultFields, 'salary_listed' | 'salary_min' | 'salary_max' | 'salary_currency' | 'salary_period'> | null): string {
  if (!f?.salary_listed || (f.salary_min == null && f.salary_max == null)) return 'Not listed';
  const cur = f.salary_currency;
  const range =
    f.salary_min != null && f.salary_max != null && f.salary_min !== f.salary_max
      ? `${money(f.salary_min, cur)}–${money(f.salary_max, cur)}`
      : money((f.salary_max ?? f.salary_min)!, cur);
  const p = normalizePeriod(f.salary_period);
  return p ? `${range}/${PERIOD_SHORT[p]}` : range;
}
