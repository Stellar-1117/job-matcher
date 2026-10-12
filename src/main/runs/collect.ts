import { ATS_SOURCE_KEYS, type CollectParams, type HealthStatus, type RunProgress, type SourceHealthRow } from '@shared/collect';
import { getHttp, type HttpClient } from '../net/http';
import { appEvents } from '../events';
import { adapterFor } from '../sources';
import { isInRange, resolveDateRange } from '../sources/dates';
import type { CompanyRef, SourceContext } from '../sources/types';
import { getCompanyRef } from '../repos/companies';
import { addLinks, applyFetchedJob, getJobItem, lookupKnownPosting, upsertCollectedJob } from '../repos/jobs';
import { addSourceHealth, createRun, getRun, latestRun, listSourceHealth, setRunStatus, updateRunProgress } from '../repos/runs';
import { redactSecrets } from '../redact';

export interface CollectDeps {
  http: HttpClient;
  now: () => Date;
  /** Companies processed in parallel (per-host limits still apply inside the HTTP client). */
  concurrency: number;
}

const defaultDeps = (): CollectDeps => ({ http: getHttp(), now: () => new Date(), concurrency: 4 });

interface ActiveRun {
  controller: AbortController;
  progress: RunProgress;
  done: Promise<void>;
}

const active = new Map<number, ActiveRun>();
const ATS_KEYS = new Set(ATS_SOURCE_KEYS);
const MANUAL_KEY = 'manual';

function emit(p: RunProgress): void {
  appEvents.emit('run:progress', structuredClone(p));
}

async function pool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  });
  await Promise.all(workers);
}

const isAbort = (e: unknown, signal: AbortSignal) => signal.aborted || (e as Error)?.name === 'AbortError';

/** Collect one company: list its postings, keep the ones in range, merge the rest's "last seen". */
async function collectCompany(company: CompanyRef, ctx: SourceContext & { signal: AbortSignal }, runId: number): Promise<SourceHealthRow | null> {
  const started = Date.now();
  const adapter = adapterFor(company.atsType);
  const label = `${company.name} (${adapter.label})`;
  let raws;
  try {
    raws = await adapter.listJobs(company, ctx);
  } catch (e) {
    if (isAbort(e, ctx.signal)) return null; // not recorded, so a resume retries it
    return addSourceHealth({
      runId,
      sourceKey: company.atsType,
      companyId: company.id,
      label,
      jobsFound: 0,
      jobsInRange: 0,
      jobsNew: 0,
      status: 'failed',
      error: (e as Error).message,
      durationMs: Date.now() - started,
    });
  }
  const nowIso = ctx.now.toISOString();
  let inRange = 0;
  let fresh = 0;
  const saveErrors: string[] = [];
  for (const raw of raws) {
    if (ctx.signal.aborted) return null;
    const inR = isInRange(raw, nowIso, ctx.range);
    if (inR) inRange++;
    try {
      const r = upsertCollectedJob(raw, { sourceKey: company.atsType, companyId: company.id, now: nowIso, insertIfNew: inR });
      if (r.outcome === 'new') fresh++;
    } catch (e) {
      saveErrors.push(`${raw.title}: ${(e as Error).message}`);
    }
  }
  let status: HealthStatus = 'ok';
  let error: string | null = null;
  if (!raws.length) {
    status = 'warning';
    error = 'The source returned no postings.';
  } else if (saveErrors.length) {
    status = 'warning';
    error = `${saveErrors.length} posting(s) couldn't be saved — ${saveErrors[0]}`;
  }
  return addSourceHealth({
    runId,
    sourceKey: company.atsType,
    companyId: company.id,
    label,
    jobsFound: raws.length,
    jobsInRange: inRange,
    jobsNew: fresh,
    status,
    error,
    durationMs: Date.now() - started,
  });
}

/** Fetch clean data for pasted ATS links (Greenhouse/Lever/Ashby/Workday) via the adapter's fetchJob. */
export async function enrichAtsJobs(
  jobIds: number[],
  ctx: SourceContext,
): Promise<{ enriched: number; failed: { url: string; error: string }[] }> {
  let enriched = 0;
  const failed: { url: string; error: string }[] = [];
  await pool(jobIds, 3, async (id) => {
    const job = getJobItem(id);
    if (!job || !ATS_KEYS.has(job.sourceKey)) return;
    const adapter = adapterFor(job.sourceKey);
    if (!adapter.fetchJob) return;
    try {
      const raw = await adapter.fetchJob(job.url, ctx);
      applyFetchedJob(id, raw, job.sourceKey);
      enriched++;
    } catch (e) {
      if (ctx.signal?.aborted) return;
      failed.push({ url: job.url, error: (e as Error).message });
    }
  });
  if (enriched) appEvents.emit('jobs:updated', { count: enriched });
  return { enriched, failed };
}

async function collectManual(text: string, ctx: SourceContext & { signal: AbortSignal }, runId: number): Promise<SourceHealthRow | null> {
  const started = Date.now();
  const r = addLinks(text);
  const atsIds = r.added.filter((j) => ATS_KEYS.has(j.sourceKey)).map((j) => j.id);
  const { enriched, failed } = await enrichAtsJobs(atsIds, ctx);
  if (ctx.signal.aborted) return null;
  const notes: string[] = [];
  if (r.duplicates.length) notes.push(`${r.duplicates.length} duplicate(s) skipped`);
  if (r.invalid.length) notes.push(`${r.invalid.length} line(s) weren't links`);
  if (enriched) notes.push(`${enriched} ATS link(s) fetched`);
  if (failed.length) notes.push(`${failed.length} ATS link(s) couldn't be fetched (${failed[0].error})`);
  return addSourceHealth({
    runId,
    sourceKey: MANUAL_KEY,
    companyId: null,
    label: 'Manual links',
    jobsFound: r.added.length + r.duplicates.length,
    jobsInRange: r.added.length,
    jobsNew: r.added.length,
    status: failed.length || r.invalid.length ? 'warning' : 'ok',
    error: notes.join(' · ') || null,
    durationMs: Date.now() - started,
  });
}

function runProgressFromDb(runId: number): RunProgress | null {
  const run = getRun(runId);
  if (!run || run.type !== 'collect') return null;
  const health = listSourceHealth(runId);
  return {
    runId,
    type: 'collect',
    status: run.status,
    total: run.total,
    done: run.done,
    failed: run.failed,
    active: [],
    jobsNew: health.reduce((s, h) => s + h.jobsNew, 0),
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    params: run.params as CollectParams,
    health,
  };
}

async function execute(runId: number, params: CollectParams, deps: CollectDeps, prior: SourceHealthRow[]): Promise<void> {
  const controller = new AbortController();
  const signal = controller.signal;
  const now = deps.now();
  const range = resolveDateRange(params.dateRange, now);
  const ctx = { http: deps.http, signal, range, now, lookupKnown: lookupKnownPosting };

  const doneCompanies = new Set(prior.map((h) => h.companyId).filter((x) => x != null));
  const manualDone = prior.some((h) => h.sourceKey === MANUAL_KEY);
  const companies = params.companyIds
    .filter((id) => !doneCompanies.has(id))
    .map((id) => getCompanyRef(id))
    .filter((c): c is CompanyRef => !!c);

  const run = getRun(runId)!;
  const progress: RunProgress = {
    runId,
    type: 'collect',
    status: 'running',
    total: run.total,
    done: prior.length,
    failed: prior.filter((h) => h.status === 'failed').length,
    active: [],
    jobsNew: prior.reduce((s, h) => s + h.jobsNew, 0),
    startedAt: run.startedAt,
    finishedAt: null,
    params,
    health: [...prior],
  };
  let resolveDone!: () => void;
  active.set(runId, { controller, progress, done: new Promise((r) => (resolveDone = r)) });
  emit(progress);

  type Task = { label: string; run: () => Promise<SourceHealthRow | null> };
  const tasks: Task[] = companies.map((c) => ({ label: c.name, run: () => collectCompany(c, ctx, runId) }));
  if (params.manualLinks.trim() && !manualDone) tasks.unshift({ label: 'Manual links', run: () => collectManual(params.manualLinks, ctx, runId) });

  try {
    await pool(tasks, deps.concurrency, async (task) => {
      if (signal.aborted) return;
      progress.active.push(task.label);
      emit(progress);
      let h: SourceHealthRow | null = null;
      try {
        h = await task.run();
      } catch (e) {
        if (!signal.aborted) {
          h = addSourceHealth({ runId, sourceKey: 'unknown', companyId: null, label: task.label, jobsFound: 0, jobsInRange: 0, jobsNew: 0, status: 'failed', error: (e as Error).message, durationMs: 0 });
        }
      }
      progress.active = progress.active.filter((l) => l !== task.label);
      if (h) {
        progress.health.push(h);
        progress.done++;
        if (h.status === 'failed') progress.failed++;
        progress.jobsNew += h.jobsNew;
        updateRunProgress(runId, { done: progress.done, failed: progress.failed });
      }
      emit(progress);
    });
    progress.status = signal.aborted ? 'cancelled' : 'completed';
  } catch (e) {
    progress.status = 'failed';
    console.error(`[collect] run failed: ${redactSecrets((e as Error)?.stack ?? String(e))}`);
  } finally {
    setRunStatus(runId, progress.status);
    progress.finishedAt = new Date().toISOString();
    progress.active = [];
    active.delete(runId);
    emit(progress);
    if (progress.jobsNew) appEvents.emit('jobs:updated', { count: progress.jobsNew });
    resolveDone();
  }
}

export function startCollect(params: CollectParams, deps: CollectDeps = defaultDeps()): { runId: number; done: Promise<void> } {
  if ([...active.values()].some((r) => r.progress.type === 'collect')) throw new Error('A collection is already running.');
  const companies = params.companyIds.map((id) => getCompanyRef(id)).filter(Boolean);
  const hasLinks = params.manualLinks.trim().length > 0;
  if (!companies.length && !hasLinks) throw new Error('Select at least one source or paste some links.');
  const runId = createRun('collect', params, companies.length + (hasLinks ? 1 : 0));
  const done = execute(runId, params, deps, []);
  return { runId, done };
}

/** Continue an interrupted/cancelled run: only sources without a result in that run are processed. */
export function resumeCollect(runId: number, deps: CollectDeps = defaultDeps()): { runId: number; done: Promise<void> } {
  if (active.has(runId)) throw new Error('This run is already running.');
  if ([...active.values()].some((r) => r.progress.type === 'collect')) throw new Error('A collection is already running.');
  const run = getRun(runId);
  if (!run || run.type !== 'collect') throw new Error('Run not found');
  if (run.status === 'completed') throw new Error('This run already completed.');
  setRunStatus(runId, 'running');
  const done = execute(runId, run.params as CollectParams, deps, listSourceHealth(runId));
  return { runId, done };
}

export function cancelRun(runId: number): void {
  active.get(runId)?.controller.abort();
}

export function collectState(): { active: RunProgress | null; last: RunProgress | null } {
  const running = [...active.values()].find((r) => r.progress.type === 'collect');
  if (running) return { active: structuredClone(running.progress), last: null };
  const latest = latestRun('collect');
  return { active: null, last: latest ? runProgressFromDb(latest.id) : null };
}
