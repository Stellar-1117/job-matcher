import { startOfLocalDay } from '@shared/dates';

export { resolveDateRange, startOfLocalDay } from '@shared/dates';

const DAY = 24 * 60 * 60 * 1000;

/**
 * Workday only shows relative dates. "Posted Today/Yesterday/N Days Ago" → approximate date
 * (start of that local day); "Posted 30+ Days Ago" → unknown date, but known to be older than 30 days.
 */
export function parseRelativePosted(text: string | null | undefined, now: Date): { postedAt: string | null; postedBefore: string | null } | null {
  if (!text) return null;
  const t = text.toLowerCase();
  if (/30\+\s*days?/.test(t)) return { postedAt: null, postedBefore: new Date(now.getTime() - 30 * DAY).toISOString() };
  if (/\btoday\b|just posted|hours? ago|minutes? ago/.test(t)) return { postedAt: startOfLocalDay(now).toISOString(), postedBefore: null };
  if (/\byesterday\b/.test(t)) return { postedAt: startOfLocalDay(new Date(now.getTime() - DAY)).toISOString(), postedBefore: null };
  const m = t.match(/(\d+)\s*days?\s*ago/);
  if (m) return { postedAt: startOfLocalDay(new Date(now.getTime() - Number(m[1]) * DAY)).toISOString(), postedBefore: null };
  return null;
}

/**
 * Is a posting inside the collection window? Uses the posting date when known, else the known
 * upper bound ("older than X"), else the date we first saw it.
 */
export function isInRange(
  job: { postedAt: string | null; postedBefore?: string | null },
  firstSeenAt: string,
  range: { from: Date; to: Date },
): boolean {
  if (job.postedAt) {
    const t = Date.parse(job.postedAt);
    if (Number.isFinite(t)) {
      // Date-only precision (start of day) must still count for the range's first day.
      return t >= startOfLocalDay(range.from).getTime() && t <= range.to.getTime();
    }
  }
  // "Posted no later than X" with X at or before the window start → certainly outside it.
  if (job.postedBefore && Date.parse(job.postedBefore) <= range.from.getTime()) return false;
  const seen = Date.parse(firstSeenAt);
  return seen >= range.from.getTime() && seen <= range.to.getTime() + 60_000;
}

/** Epoch ms or ISO → ISO string, or null. */
export function toIso(v: string | number | null | undefined): string | null {
  if (v == null || v === '') return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}
