import { z } from 'zod';
import { DateRangeSchema } from './settings';
import type { RunStatus } from './collect';
import type { Verdict } from './scoring';

// ---- Run parameters -------------------------------------------------------------------------

export const AnalyzeParamsSchema = z.object({
  profileIds: z.array(z.number().int().positive()).min(1, 'Choose at least one profile').max(50),
  dateRange: DateRangeSchema,
  /** Which date the range applies to: the posting date (falling back to first seen) or the day the job was added. */
  dateField: z.enum(['posted', 'added']).default('posted'),
  /** Job source keys to include ("greenhouse", "manual:linkedin.com", …). Empty = all sources. */
  sourceKeys: z.array(z.string().max(300)).max(1000),
  /** Re-run jobs that already have an analysis for the current resume, prompt and model. */
  reanalyze: z.boolean(),
  /** Analyze exactly these jobs instead of filtering by date and source (e.g. "re-analyze selected"). */
  jobIds: z.array(z.number().int().positive()).max(100_000).nullable().default(null),
});
export type AnalyzeParams = z.infer<typeof AnalyzeParamsSchema>;
export type AnalyzeParamsInput = z.input<typeof AnalyzeParamsSchema>;

// ---- Estimate -------------------------------------------------------------------------------

export interface TaskEstimate {
  task: 'job_extraction' | 'pre_score' | 'matching';
  calls: number;
  model: string | null;
  /** Average tokens per call used for the estimate. */
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** "history" = averaged from your usage log; "default" = built-in assumption (no history yet). */
  basis: 'history' | 'default';
  costUsd: number;
}

export interface AnalyzeEstimate {
  jobs: number;
  profiles: number;
  /** Jobs that still need their description fetched (cost: time, not tokens). */
  needFetch: number;
  /** Jobs waiting for a pasted description; they're skipped until you paste it. */
  needPaste: number;
  needExtraction: number;
  /** Job × profile pairs that will go to the LLM (upper bound: some may still fail hard filters). */
  needMatching: number;
  /** Pairs already analyzed with the current resume, prompt and model (no cost, unless re-analyze is on). */
  cached: number;
  /** Pairs already known to fail a hard filter (no cost). */
  hardFiltered: number;
  tasks: TaskEstimate[];
  totalUsd: number;
  monthSpentUsd: number;
  monthlyBudgetUsd: number;
  /** True when this run would take the month's spend over the budget cap (cap 0 = no cap). */
  exceedsBudget: boolean;
  /** Profiles that can't be analyzed (no parsed resume). */
  profileProblems: { profileId: number; name: string; problem: string }[];
  /** Job counts per source inside the date range (ignores the source filter), for the source picker. */
  sources: { key: string; label: string; count: number }[];
}

// ---- Progress -------------------------------------------------------------------------------

export const PREPARE_OUTCOMES = ['extracted', 'cached', 'closed', 'needs_text'] as const;
export const MATCH_OUTCOMES = ['matched', 'cached', 'hard_filter', 'pre_score_skip', 'job_closed', 'needs_text'] as const;
export type PrepareOutcome = (typeof PREPARE_OUTCOMES)[number];
export type MatchOutcome = (typeof MATCH_OUTCOMES)[number];

export type ItemStatus = 'pending' | 'done' | 'skipped' | 'failed' | 'blocked';

export interface AnalyzeItemError {
  itemId: number;
  jobId: number | null;
  jobTitle: string | null;
  companyName: string | null;
  profileName: string | null;
  step: 'prepare' | 'match';
  status: ItemStatus;
  error: string;
}

export interface AnalyzeProgress {
  runId: number;
  type: 'analyze';
  status: RunStatus;
  params: AnalyzeParams;
  startedAt: string;
  finishedAt: string | null;
  estimateUsd: number | null;
  costUsd: number;
  jobs: { total: number; finished: number };
  matches: { total: number; finished: number };
  failed: number;
  /** Items waiting on something outside the run (a pasted description, or a job that failed to prepare). */
  blocked: number;
  /** Items still to do (pending + failed + blocked) — what "Resume" would process. */
  remaining: number;
  prepareOutcomes: Partial<Record<PrepareOutcome, number>>;
  matchOutcomes: Partial<Record<MatchOutcome, number>>;
  /** Titles of the jobs being worked on right now. */
  active: string[];
  errors: AnalyzeItemError[];
}

// ---- Results (Milestone 4 preview; the full results screen comes in Milestone 5) ------------

export interface AnalysisRow {
  analysisId: number;
  jobId: number;
  profileId: number;
  profileName: string;
  title: string | null;
  companyName: string | null;
  url: string;
  outcome: 'matched' | 'hard_filter' | 'pre_score_skip';
  total: number | null;
  verdict: Verdict | null;
  summary: string | null;
  hardFilterReasons: string[];
  preScore: number | null;
  preScoreReason: string | null;
  modelName: string | null;
  createdAt: string;
}

// ---- Manual paste & unreadable log ----------------------------------------------------------

export interface UnreadableDomain {
  domain: string;
  count: number;
  lastReason: string;
  lastAt: string;
}

/** Minimum characters for pasted job text. */
export const MIN_PASTED_TEXT = 80;
