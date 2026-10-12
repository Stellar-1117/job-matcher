import type { DateRange } from './settings';

const DAY = 24 * 60 * 60 * 1000;

export function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function endOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

function parseLocalDate(ymd: string): Date | null {
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

/** Turn a date-range setting into concrete bounds (local time). */
export function resolveDateRange(range: DateRange, now: Date): { from: Date; to: Date } {
  switch (range.preset) {
    case 'today':
      return { from: startOfLocalDay(now), to: now };
    case 'last7':
      return { from: new Date(now.getTime() - 7 * DAY), to: now };
    case 'last30':
      return { from: new Date(now.getTime() - 30 * DAY), to: now };
    case 'custom': {
      const from = range.from ? parseLocalDate(range.from) : null;
      const to = range.to ? parseLocalDate(range.to) : null;
      return { from: from ?? new Date(0), to: to ? endOfLocalDay(to) : now };
    }
  }
}

/** Which job date a range applies to: posting date (falling back to first seen) or the day it was added. */
export type JobDateField = 'posted' | 'added';

/** Is the job inside the range by the chosen date? Date-only precision counts for the range's first day. */
export function jobInDateRange(
  job: { postedAt: string | null; firstSeenAt: string },
  range: { from: Date; to: Date },
  field: JobDateField,
): boolean {
  const t = Date.parse(field === 'added' ? job.firstSeenAt : (job.postedAt ?? job.firstSeenAt));
  if (!Number.isFinite(t)) return false;
  return t >= startOfLocalDay(range.from).getTime() && t <= range.to.getTime() + 60_000;
}
