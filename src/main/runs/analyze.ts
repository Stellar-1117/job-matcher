import {
  AnalyzeParamsSchema,
  type AnalyzeEstimate,
  type AnalyzeParams,
  type AnalyzeProgress,
  type ItemStatus,
  type MatchOutcome,
  type PrepareOutcome,
} from '@shared/analysis';
import { getHttp, type HttpClient } from '../net/http';
import { appEvents } from '../events';
import { redactSecrets } from '../redact';
import { getSettings } from '../repos/settings';
import { createRun, getRun, latestRun, runUsageCost, setRunCost, setRunStatus, updateRunProgress } from '../repos/runs';
import { createRunItems, finishItem, getJobForAnalysis, summarizeRunItems, unfinishedItems, type RunItem } from '../repos/analysis';
import { estimateAnalyze, selectCandidates } from '../analysis/estimate';
import type { PageRenderer } from '../analysis/fetch';
import { loadProfileContext, matchJob, prepareJob, type ProfileContext, type StepDeps } from '../analysis/pipeline';

/**
 * Analyze runs (§5 Execution): a persistent queue of run items (one "prepare" item per job, one
 * "match" item per job × profile) stored in the DB, processed with configurable concurrency.
 * A failed item never fails the run; cancel leaves unfinished items pending; resume (manual, or
 * automatic after an app restart) processes whatever is left.
 */

export interface AnalyzeDeps {
  http: HttpClient;
  render: PageRenderer | null;
  now: () => Date;
  /** Jobs processed in parallel; defaults to the Concurrency setting. */
  concurrency?: number;
}

let defaultRender: PageRenderer | null = null;
/** The hidden-browser renderer is Electron-only, so main/index.ts injects it. */
export function setDefaultRenderer(r: PageRenderer | null): void {
  defaultRender = r;
}

const defaultDeps = (): AnalyzeDeps => ({ http: getHttp(), render: defaultRender, now: () => new Date() });

export class BudgetExceededError extends Error {
  override name = 'BudgetExceededError';
}

interface StoredParams extends AnalyzeParams {
  estimateUsd: number | null;
}

interface ActiveRun {
  runId: number;
  controller: AbortController;
  /** jobId → label, for "Working on: …". */
  working: Map<number, string>;
  emitTimer: ReturnType<typeof setTimeout> | null;
}

let current: ActiveRun | null = null;

async function pool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (i < items.length) await fn(items[i++]);
  });
  await Promise.all(workers);
}

const isAbort = (e: unknown, signal: AbortSignal) => signal.aborted || (e as Error)?.name === 'AbortError';
const errText = (e: unknown) => redactSecrets((e as Error)?.message ?? String(e));

export function buildProgress(runId: number): AnalyzeProgress | null {
  const run = getRun(runId);
  if (!run || run.type !== 'analyze') return null;
  const { counts, errors } = summarizeRunItems(runId);
  const p: AnalyzeProgress = {
    runId,
    type: 'analyze',
    status: run.status,
    params: run.params as AnalyzeParams,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    estimateUsd: (run.params as StoredParams).estimateUsd ?? null,
    costUsd: runUsageCost(runId),
    jobs: { total: 0, finished: 0 },
    matches: { total: 0, finished: 0 },
    failed: 0,
    blocked: 0,
    remaining: 0,
    prepareOutcomes: {},
    matchOutcomes: {},
    active: current?.runId === runId ? [...current.working.values()] : [],
    errors,
  };
  for (const c of counts) {
    const bucket = c.step === 'prepare' ? p.jobs : p.matches;
    bucket.total += c.n;
    if (c.status !== 'pending') bucket.finished += c.n;
    if (c.status === 'failed') p.failed += c.n;
    if (c.status === 'blocked') p.blocked += c.n;
    if (c.status === 'pending' || c.status === 'failed' || c.status === 'blocked') p.remaining += c.n;
    if (c.outcome) {
      const map = (c.step === 'prepare' ? p.prepareOutcomes : p.matchOutcomes) as Record<string, number>;
      map[c.outcome] = (map[c.outcome] ?? 0) + c.n;
    }
  }
  return p;
}

function emitNow(runId: number): void {
  const p = buildProgress(runId);
  if (p) appEvents.emit('analyze:progress', p);
}

/** Progress events are throttled: the UI doesn't need one per item on a 1,000-job run. */
function scheduleEmit(run: ActiveRun): void {
  if (run.emitTimer) return;
  run.emitTimer = setTimeout(() => {
    run.emitTimer = null;
    emitNow(run.runId);
  }, 250);
}

function jobLabel(jobId: number): string {
  const j = getJobForAnalysis(jobId);
  if (!j) return `Job ${jobId}`;
  return [j.title ?? j.url, j.companyName].filter(Boolean).join(' · ');
}

async function processJob(
  jobId: number,
  items: RunItem[],
  ctx: { deps: StepDeps; profiles: Map<number, ProfileContext | Error>; reanalyze: boolean; signal: AbortSignal; onItem: () => void },
): Promise<void> {
  const settings = getSettings();
  const prep = items.find((i) => i.step === 'prepare');
  let state: PrepareOutcome | 'failed';

  if (prep) {
    try {
      const r = await prepareJob(jobId, ctx.deps, settings.taxonomy);
      const status: ItemStatus = r.outcome === 'needs_text' ? 'blocked' : 'done';
      finishItem(prep.id, {
        status,
        outcome: r.outcome,
        error: r.outcome === 'needs_text' ? `Needs a pasted description — ${r.detail ?? 'the page could not be read'}` : null,
        costUsd: r.costUsd,
      });
      state = r.outcome;
    } catch (e) {
      if (isAbort(e, ctx.signal)) return; // stays pending; a resume picks it up
      finishItem(prep.id, { status: 'failed', error: errText(e) });
      state = 'failed';
    }
    ctx.onItem();
  } else {
    // Prepared in an earlier pass of this run: derive the state from the job.
    const j = getJobForAnalysis(jobId);
    state = !j ? 'failed' : j.isClosed ? 'closed' : j.extractionId != null ? 'extracted' : j.fetchStatus === 'unreadable' ? 'needs_text' : 'failed';
  }

  for (const it of items.filter((i) => i.step === 'match')) {
    if (ctx.signal.aborted) return;
    if (state === 'closed') {
      finishItem(it.id, { status: 'skipped', outcome: 'job_closed' satisfies MatchOutcome });
    } else if (state === 'needs_text') {
      finishItem(it.id, { status: 'blocked', outcome: 'needs_text' satisfies MatchOutcome, error: 'Waiting for the job description to be pasted' });
    } else if (state === 'failed') {
      finishItem(it.id, { status: 'blocked', error: "Skipped: the job couldn't be prepared (see its error)" });
    } else {
      const profile = ctx.profiles.get(it.profileId!);
      if (!profile || profile instanceof Error) {
        finishItem(it.id, { status: 'failed', error: profile instanceof Error ? errText(profile) : 'Profile not found' });
      } else {
        try {
          const r = await matchJob(jobId, profile, ctx.deps, { reanalyze: ctx.reanalyze, preScore: settings.preScore, taxonomy: settings.taxonomy });
          finishItem(it.id, { status: r.outcome === 'job_closed' ? 'skipped' : 'done', outcome: r.outcome, error: null, costUsd: r.costUsd });
        } catch (e) {
          if (isAbort(e, ctx.signal)) return;
          finishItem(it.id, { status: 'failed', error: errText(e) });
        }
      }
    }
    ctx.onItem();
  }
}

async function execute(runId: number, deps: AnalyzeDeps): Promise<void> {
  const controller = new AbortController();
  const signal = controller.signal;
  const run: ActiveRun = { runId, controller, working: new Map(), emitTimer: null };
  current = run;
  const params = getRun(runId)!.params as StoredParams;
  let status: 'completed' | 'cancelled' | 'failed' = 'completed';
  emitNow(runId);

  try {
    const items = unfinishedItems(runId);
    const byJob = new Map<number, RunItem[]>();
    for (const it of items) {
      const list = byJob.get(it.jobId) ?? [];
      list.push(it);
      byJob.set(it.jobId, list);
    }
    const profiles = new Map<number, ProfileContext | Error>();
    for (const pid of new Set(items.map((i) => i.profileId).filter((x): x is number => x != null))) {
      try {
        profiles.set(pid, loadProfileContext(pid));
      } catch (e) {
        profiles.set(pid, e as Error);
      }
    }
    const stepDeps: StepDeps = { http: deps.http, render: deps.render, now: deps.now, signal, runId };
    const concurrency = deps.concurrency ?? getSettings().concurrency;
    await pool([...byJob.entries()], concurrency, async ([jobId, jobItems]) => {
      if (signal.aborted) return;
      run.working.set(jobId, jobLabel(jobId));
      scheduleEmit(run);
      try {
        await processJob(jobId, jobItems, {
          deps: stepDeps,
          profiles,
          reanalyze: params.reanalyze,
          signal,
          onItem: () => scheduleEmit(run),
        });
      } finally {
        run.working.delete(jobId);
        scheduleEmit(run);
      }
    });
    status = signal.aborted ? 'cancelled' : 'completed';
  } catch (e) {
    status = 'failed';
    console.error(`[analyze] run failed: ${redactSecrets((e as Error)?.stack ?? String(e))}`);
  } finally {
    if (run.emitTimer) clearTimeout(run.emitTimer);
    const p = buildProgress(runId);
    if (p) updateRunProgress(runId, { done: p.jobs.finished + p.matches.finished, failed: p.failed });
    setRunCost(runId, runUsageCost(runId));
    setRunStatus(runId, status);
    current = null;
    emitNow(runId);
    appEvents.emit('jobs:updated', { count: 0 });
  }
}

/** Estimate for the UI, with the same validation the run uses. */
export function estimate(params: AnalyzeParams, now = new Date()): AnalyzeEstimate {
  return estimateAnalyze(AnalyzeParamsSchema.parse(params), now);
}

export function startAnalyze(
  input: { params: AnalyzeParams; budgetOverride: boolean },
  deps: AnalyzeDeps = defaultDeps(),
): { runId: number; done: Promise<void> } {
  if (current) throw new Error('An analysis is already running.');
  const params = AnalyzeParamsSchema.parse(input.params);
  const now = deps.now();
  const est = estimateAnalyze(params, now);
  if (est.profileProblems.length) throw new Error(est.profileProblems.map((p) => `${p.name}: ${p.problem}`).join(' · '));
  if (!est.jobs) throw new Error('No jobs match these filters.');
  if (est.exceedsBudget && !input.budgetOverride) {
    throw new BudgetExceededError(
      `This run (~$${est.totalUsd.toFixed(2)}) would take this month's spend to $${(est.monthSpentUsd + est.totalUsd).toFixed(2)}, over your $${est.monthlyBudgetUsd.toFixed(2)} budget.`,
    );
  }
  const jobIds = selectCandidates(params, now).selected.map((j) => j.id);
  const stored: StoredParams = { ...params, estimateUsd: est.totalUsd };
  const runId = createRun('analyze', stored, jobIds.length * (1 + params.profileIds.length));
  createRunItems(runId, jobIds, params.profileIds);
  return { runId, done: execute(runId, deps) };
}

/** Process what's left of a run: pending, failed and blocked items (e.g. after pasting descriptions). */
export function resumeAnalyze(runId: number, deps: AnalyzeDeps = defaultDeps()): { runId: number; done: Promise<void> } {
  if (current) throw new Error('An analysis is already running.');
  const run = getRun(runId);
  if (!run || run.type !== 'analyze') throw new Error('Run not found');
  if (!unfinishedItems(runId).length) throw new Error('Nothing left to do in this run.');
  setRunStatus(runId, 'running');
  return { runId, done: execute(runId, deps) };
}

export function cancelAnalyze(runId: number): void {
  if (current?.runId === runId) current.controller.abort();
}

export function analyzeState(): { active: AnalyzeProgress | null; last: AnalyzeProgress | null } {
  if (current) return { active: buildProgress(current.runId), last: null };
  const latest = latestRun('analyze');
  return { active: null, last: latest ? buildProgress(latest.id) : null };
}
