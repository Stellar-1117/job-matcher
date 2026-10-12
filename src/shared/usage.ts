/** Usage & cost screen (§14) data. */

export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
}

export interface UsageGroup extends UsageTotals {
  key: string;
  label: string;
}

export interface UsageRun extends UsageTotals {
  /** null = calls made outside a run (resume parsing, "Test route"). */
  runId: number | null;
  type: 'collect' | 'analyze' | null;
  status: string | null;
  startedAt: string | null;
  estimateUsd: number | null;
  profiles: string[];
  jobs: number | null;
}

export interface UsageSummary {
  /** "YYYY-MM" (local time). */
  month: string;
  /** Months with any usage, newest first (always includes the current month). */
  months: string[];
  totals: UsageTotals;
  budgetUsd: number;
  isCurrentMonth: boolean;
  /** Straight-line projection for the whole month (current month only). */
  projectedUsd: number | null;
  byTask: UsageGroup[];
  byModel: UsageGroup[];
  /** One entry per day of the month (local), zero-filled; future days omitted for the current month. */
  byDay: { day: string; costUsd: number; calls: number }[];
  runs: UsageRun[];
}

export function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
