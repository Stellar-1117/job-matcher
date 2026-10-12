import { getDb, nowIso } from '../db';
import { StoredJobExtractionSchema, isLegacyExtraction, type JobExtraction, type MatchResult } from '@shared/llm-schemas';
import type { AnalysisRow, AnalyzeItemError, ItemStatus, UnreadableDomain } from '@shared/analysis';
import type { HardFilterOutcome } from '@shared/hardFilters';
import { computeTotal, computeVerdict, type Thresholds, type Weights } from '@shared/scoring';
import type { JobListItem } from '@shared/jobs';
import { getJobItem } from './jobs';

// ---- Jobs: what the pipeline needs ----------------------------------------------------------

export interface JobForAnalysis {
  id: number;
  url: string;
  sourceKey: string;
  companyId: number | null;
  companyName: string | null;
  title: string | null;
  location: string | null;
  description: string | null;
  fetchStatus: string;
  isClosed: boolean;
  lastSeenAt: string | null;
  extractionId: number | null;
}

export function getJobForAnalysis(id: number): JobForAnalysis | null {
  const r = getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(id) as any;
  if (!r) return null;
  return {
    id: r.id,
    url: r.canonical_url,
    sourceKey: r.source_key,
    companyId: r.company_id ?? null,
    companyName: r.company_name,
    title: r.title,
    location: r.location_raw,
    description: r.description_text && String(r.description_text).trim() ? r.description_text : null,
    fetchStatus: r.fetch_status,
    isClosed: r.is_closed === 1,
    lastSeenAt: r.last_seen_at ?? null,
    extractionId: r.extraction_id ?? null,
  };
}

export function saveFetchedText(jobId: number, text: string, now = nowIso()): void {
  getDb()
    .prepare("UPDATE jobs SET description_text = ?, fetch_status = 'fetched', fetch_error = NULL, fetched_at = ?, updated_at = ? WHERE id = ?")
    .run(text, now, now, jobId);
}

export function setTitleIfMissing(jobId: number, title: string | null): void {
  const t = title?.replace(/\s+/g, ' ').trim();
  if (!t) return;
  getDb().prepare("UPDATE jobs SET title = ? WHERE id = ? AND (title IS NULL OR title = '')").run(t.slice(0, 300), jobId);
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Fetch ladder gave up (or the text isn't a job page): queue for a manual paste and log the domain (§3.3). */
export function markUnreadable(jobId: number, url: string, reason: string, now = nowIso()): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      "UPDATE jobs SET fetch_status = 'unreadable', fetch_error = ?, description_text = NULL, extraction_id = NULL, fetched_at = ?, updated_at = ? WHERE id = ?",
    ).run(reason, now, now, jobId);
    db.prepare('INSERT INTO unreadable_log (job_id, domain, url, reason, created_at) VALUES (?, ?, ?, ?, ?)').run(jobId, domainOf(url), url, reason, now);
  })();
}

export function markClosed(jobId: number, reason: string, now = nowIso()): void {
  getDb().prepare('UPDATE jobs SET is_closed = 1, closed_reason = ?, closed_detected_at = ?, updated_at = ? WHERE id = ?').run(reason, now, now, jobId);
}

/**
 * Save a pasted job description (§3.3 step 4). The job text changed, so any extraction made from
 * the old text no longer applies.
 */
export function savePastedText(jobId: number, text: string, now = nowIso()): void {
  const db = getDb();
  db.transaction(() => {
    const res = db
      .prepare("UPDATE jobs SET description_text = ?, fetch_status = 'manual_text', fetch_error = NULL, fetched_at = ?, extraction_id = NULL, updated_at = ? WHERE id = ?")
      .run(text, now, now, jobId);
    if (!res.changes) throw new Error('Job not found');
    db.prepare('DELETE FROM job_extractions WHERE job_id = ?').run(jobId);
    db.prepare('DELETE FROM job_tags WHERE job_id = ?').run(jobId);
  })();
}

/** Put an unreadable job back to "not fetched" so the next analysis tries the fetch ladder again. */
export function resetFetch(jobId: number): void {
  getDb().prepare("UPDATE jobs SET fetch_status = 'pending', fetch_error = NULL WHERE id = ? AND fetch_status = 'unreadable'").run(jobId);
}

/** Let every unreadable job be fetched again on the next analysis run. Returns how many were reset. */
export function resetAllUnreadable(): number {
  return getDb().prepare("UPDATE jobs SET fetch_status = 'pending', fetch_error = NULL WHERE fetch_status = 'unreadable' AND is_closed = 0").run().changes;
}

export function listNeedsPaste(): JobListItem[] {
  const rows = getDb().prepare("SELECT id FROM jobs WHERE fetch_status = 'unreadable' AND is_closed = 0 ORDER BY updated_at DESC").all() as { id: number }[];
  return rows.map((r) => getJobItem(r.id)).filter((j): j is JobListItem => j != null);
}

export function listUnreadableDomains(): UnreadableDomain[] {
  return (
    getDb()
      .prepare(
        `SELECT domain, COUNT(*) AS count, MAX(created_at) AS last_at,
           (SELECT reason FROM unreadable_log u2 WHERE u2.domain = u.domain ORDER BY id DESC LIMIT 1) AS last_reason
         FROM unreadable_log u GROUP BY domain ORDER BY count DESC, last_at DESC LIMIT 50`,
      )
      .all() as any[]
  ).map((r) => ({ domain: r.domain, count: r.count, lastReason: r.last_reason, lastAt: r.last_at }));
}

/** ATS adapters whose listing returns every open posting (others stop early at the date window). */
const COMPLETE_LISTING_SOURCES = ['greenhouse', 'lever', 'ashby'];

/**
 * "The ATS API no longer lists it": a later successful collection of the job's company didn't
 * include it. Only for adapters that list all postings.
 */
export function noLongerListed(job: Pick<JobForAnalysis, 'id' | 'companyId' | 'sourceKey' | 'lastSeenAt'>): boolean {
  if (job.companyId == null || !job.lastSeenAt || !COMPLETE_LISTING_SOURCES.includes(job.sourceKey)) return false;
  const r = getDb()
    .prepare(
      `SELECT 1 FROM source_health h JOIN runs r ON r.id = h.run_id JOIN companies c ON c.id = h.company_id
       WHERE h.company_id = ? AND h.status IN ('ok', 'warning') AND h.jobs_found > 0 AND c.ats_type = ? AND r.started_at > ?
       LIMIT 1`,
    )
    .get(job.companyId, job.sourceKey, job.lastSeenAt);
  return !!r;
}

// ---- Job extractions ------------------------------------------------------------------------

export interface ExtractionRow {
  id: number;
  jobId: number;
  promptVersionId: number;
  modelId: number;
  modelName: string;
  fields: JobExtraction;
}

function toExtraction(r: any, opts: { allowLegacy: boolean }): ExtractionRow | null {
  if (!r) return null;
  const raw = JSON.parse(r.fields_json);
  if (!opts.allowLegacy && isLegacyExtraction(raw)) return null;
  const parsed = StoredJobExtractionSchema.safeParse(raw);
  if (!parsed.success) return null;
  return { id: r.id, jobId: r.job_id, promptVersionId: r.prompt_version_id, modelId: r.model_id, modelName: r.model_name, fields: parsed.data };
}

/** Cached extraction for this prompt + model. Ones made before job title / company / location were extracted don't count, so they get redone. */
export function findExtraction(jobId: number, promptVersionId: number, modelId: number): ExtractionRow | null {
  return toExtraction(getDb().prepare('SELECT * FROM job_extractions WHERE job_id = ? AND prompt_version_id = ? AND model_id = ?').get(jobId, promptVersionId, modelId), {
    allowLegacy: false,
  });
}

export function getExtraction(id: number): ExtractionRow | null {
  return toExtraction(getDb().prepare('SELECT * FROM job_extractions WHERE id = ?').get(id), { allowLegacy: true });
}

function writeTags(jobId: number, f: JobExtraction): void {
  const db = getDb();
  db.prepare('DELETE FROM job_tags WHERE job_id = ?').run(jobId);
  const ins = db.prepare('INSERT OR IGNORE INTO job_tags (job_id, tag_type, tag) VALUES (?, ?, ?)');
  const lists: [string, string[]][] = [
    ['tech', f.tech_stack],
    ['domain', f.problem_domains],
    ['skill_must', f.must_have_skills],
    ['skill_nice', f.nice_to_have_skills],
  ];
  for (const [type, tags] of lists) for (const t of tags) if (t.trim()) ins.run(jobId, type, t.trim());
}

/** Make an extraction the job's current one: denormalized filter columns live on the extraction row, tags on job_tags. */
export function useExtraction(jobId: number, extractionId: number): void {
  const db = getDb();
  const ex = getExtraction(extractionId);
  if (!ex) throw new Error('Extraction not found');
  db.transaction(() => {
    db.prepare('UPDATE jobs SET extraction_id = ? WHERE id = ?').run(extractionId, jobId);
    writeTags(jobId, ex.fields);
  })();
}

/**
 * Use what the posting says about itself on the job row: pasted links only know the page title
 * ("Role | Company's Open Positions", "Career Center"), so the extracted role title replaces it;
 * collected (ATS) jobs keep their exact title. Missing company and location are filled in.
 */
function applyPostingIdentity(jobId: number, f: JobExtraction): void {
  getDb()
    .prepare(
      `UPDATE jobs SET
         title = CASE WHEN @title IS NOT NULL AND (source_key LIKE 'manual:%' OR title IS NULL OR title = '') THEN @title ELSE title END,
         company_name = COALESCE(NULLIF(company_name, ''), @company),
         location_raw = COALESCE(NULLIF(location_raw, ''), @location)
       WHERE id = @id`,
    )
    .run({ id: jobId, title: f.job_title?.slice(0, 300) ?? null, company: f.company_name?.slice(0, 200) ?? null, location: f.location?.slice(0, 300) ?? null });
}

export function saveExtraction(
  jobId: number,
  e: { promptVersionId: number; modelId: number; usedModelId: number; modelName: string; fields: JobExtraction; costUsd: number },
): number {
  const db = getDb();
  const f = e.fields;
  const id = db.transaction(() => {
    db.prepare(
      `INSERT INTO job_extractions (job_id, prompt_version_id, model_id, used_model_id, model_name, fields_json, job_function, seniority, industry,
         company_stage, work_mode, employment_type, remote_region, country, city, salary_min, salary_max, salary_currency, salary_period,
         salary_listed, visa_sponsorship, required_years, cost_usd)
       VALUES (@job_id, @prompt, @model, @used, @model_name, @json, @job_function, @seniority, @industry, @company_stage, @work_mode,
         @employment_type, @remote_region, @country, @city, @salary_min, @salary_max, @salary_currency, @salary_period, @salary_listed,
         @visa_sponsorship, @required_years, @cost)
       ON CONFLICT(job_id, prompt_version_id, model_id) DO UPDATE SET used_model_id = excluded.used_model_id, model_name = excluded.model_name,
         fields_json = excluded.fields_json, job_function = excluded.job_function, seniority = excluded.seniority, industry = excluded.industry,
         company_stage = excluded.company_stage, work_mode = excluded.work_mode, employment_type = excluded.employment_type,
         remote_region = excluded.remote_region, country = excluded.country, city = excluded.city, salary_min = excluded.salary_min,
         salary_max = excluded.salary_max, salary_currency = excluded.salary_currency, salary_period = excluded.salary_period,
         salary_listed = excluded.salary_listed, visa_sponsorship = excluded.visa_sponsorship, required_years = excluded.required_years,
         cost_usd = excluded.cost_usd, created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    ).run({
      job_id: jobId,
      prompt: e.promptVersionId,
      model: e.modelId,
      used: e.usedModelId,
      model_name: e.modelName,
      json: JSON.stringify(f),
      job_function: f.job_function,
      seniority: f.seniority,
      industry: f.industry,
      company_stage: f.company_stage,
      work_mode: f.work_mode,
      employment_type: f.employment_type,
      remote_region: f.remote_region,
      country: f.country,
      city: f.city,
      salary_min: f.salary_min,
      salary_max: f.salary_max,
      salary_currency: f.salary_currency,
      salary_period: f.salary_period,
      salary_listed: f.salary_listed ? 1 : 0,
      visa_sponsorship: f.visa_sponsorship,
      required_years: f.required_years,
      cost: e.costUsd,
    });
    const row = db.prepare('SELECT id FROM job_extractions WHERE job_id = ? AND prompt_version_id = ? AND model_id = ?').get(jobId, e.promptVersionId, e.modelId) as { id: number };
    db.prepare('UPDATE jobs SET extraction_id = ? WHERE id = ?').run(row.id, jobId);
    applyPostingIdentity(jobId, f);
    writeTags(jobId, f);
    return row.id;
  })();
  return id;
}

// ---- Analyses -------------------------------------------------------------------------------

/** An analysis is unique on these (§5 caching rule). `modelId` is the matching route's model. */
export interface AnalysisKey {
  jobId: number;
  profileId: number;
  resumeId: number;
  promptVersionId: number;
  modelId: number;
}

export interface StoredAnalysis {
  id: number;
  outcome: 'matched' | 'hard_filter' | 'pre_score_skip';
  hardFilterPass: boolean;
  preScore: number | null;
  preScoreReason: string | null;
  hasMatch: boolean;
}

export function findAnalysis(k: AnalysisKey): StoredAnalysis | null {
  const r = getDb()
    .prepare('SELECT * FROM analyses WHERE job_id = ? AND profile_id = ? AND resume_id = ? AND prompt_version_id = ? AND model_id = ?')
    .get(k.jobId, k.profileId, k.resumeId, k.promptVersionId, k.modelId) as any;
  if (!r) return null;
  return { id: r.id, outcome: r.outcome, hardFilterPass: r.hard_filter_pass === 1, preScore: r.pre_score, preScoreReason: r.pre_score_reason, hasMatch: r.sub_scores_json != null };
}

export interface AnalysisWrite {
  outcome: StoredAnalysis['outcome'];
  extractionId: number | null;
  hard: HardFilterOutcome;
  runId: number | null;
  /** LLM results; omitted fields keep their stored values (e.g. re-checking hard filters only). */
  usedModelId?: number | null;
  modelName?: string | null;
  preScore?: { score: number; reason: string } | null;
  match?: MatchResult | null;
  addCostUsd?: number;
}

export function upsertAnalysis(k: AnalysisKey, w: AnalysisWrite): number {
  const db = getDb();
  const now = nowIso();
  const existing = findAnalysis(k);
  const hardCols = {
    outcome: w.outcome,
    extraction_id: w.extractionId,
    hard_filter_pass: w.hard.pass ? 1 : 0,
    hard_filter_reasons_json: JSON.stringify(w.hard.reasons),
    hard_filter_results_json: JSON.stringify(w.hard.results),
    run_id: w.runId,
    updated_at: now,
  };
  const llmCols: Record<string, unknown> = {};
  if (w.usedModelId !== undefined) llmCols.used_model_id = w.usedModelId;
  if (w.modelName !== undefined) llmCols.model_name = w.modelName;
  if (w.preScore !== undefined) {
    llmCols.pre_score = w.preScore?.score ?? null;
    llmCols.pre_score_reason = w.preScore?.reason ?? null;
  }
  if (w.match !== undefined) {
    llmCols.sub_scores_json = w.match ? JSON.stringify(w.match.sub_scores) : null;
    llmCols.strengths_json = w.match ? JSON.stringify(w.match.strengths) : null;
    llmCols.gaps_json = w.match ? JSON.stringify(w.match.gaps) : null;
    llmCols.summary = w.match?.summary ?? null;
  }
  const cols = { ...hardCols, ...llmCols };
  if (existing) {
    const sets = Object.keys(cols).map((c) => `${c} = @${c}`);
    if (w.addCostUsd) sets.push('cost_usd = cost_usd + @add_cost');
    db.prepare(`UPDATE analyses SET ${sets.join(', ')} WHERE id = @id`).run({ ...cols, add_cost: w.addCostUsd ?? 0, id: existing.id });
    return existing.id;
  }
  const all = { job_id: k.jobId, profile_id: k.profileId, resume_id: k.resumeId, prompt_version_id: k.promptVersionId, model_id: k.modelId, cost_usd: w.addCostUsd ?? 0, created_at: now, ...cols };
  const names = Object.keys(all);
  const res = db.prepare(`INSERT INTO analyses (${names.join(', ')}) VALUES (${names.map((n) => `@${n}`).join(', ')})`).run(all);
  return Number(res.lastInsertRowid);
}

/** Analyses written by a run, newest scores computed from the current weights (no LLM). */
export function listRunAnalyses(runId: number, weights: Weights, thresholds: Thresholds): AnalysisRow[] {
  const rows = getDb()
    .prepare(
      `SELECT a.*, j.title, j.company_name, j.canonical_url, p.name AS profile_name
       FROM analyses a JOIN jobs j ON j.id = a.job_id JOIN profiles p ON p.id = a.profile_id
       WHERE a.run_id = ? ORDER BY a.id`,
    )
    .all(runId) as any[];
  const out = rows.map((r): AnalysisRow => {
    let total: number | null = null;
    if (r.sub_scores_json && r.outcome === 'matched') {
      const subs = JSON.parse(r.sub_scores_json) as Record<string, { score: number }>;
      total = computeTotal(Object.fromEntries(Object.entries(subs).map(([k, v]) => [k, v.score])) as any, weights);
    }
    return {
      analysisId: r.id,
      jobId: r.job_id,
      profileId: r.profile_id,
      profileName: r.profile_name,
      title: r.title,
      companyName: r.company_name,
      url: r.canonical_url,
      outcome: r.outcome,
      total,
      verdict: total != null ? computeVerdict(total, thresholds) : r.outcome === 'pre_score_skip' ? 'skip' : null,
      summary: r.summary,
      hardFilterReasons: JSON.parse(r.hard_filter_reasons_json ?? '[]'),
      preScore: r.pre_score,
      preScoreReason: r.pre_score_reason,
      modelName: r.model_name,
      createdAt: r.created_at,
    };
  });
  return out.sort((a, b) => (b.total ?? -1) - (a.total ?? -1) || a.analysisId - b.analysisId);
}

// ---- Run items ------------------------------------------------------------------------------

export interface RunItem {
  id: number;
  runId: number;
  jobId: number;
  profileId: number | null;
  step: 'prepare' | 'match';
  status: ItemStatus;
  outcome: string | null;
}

export function createRunItems(runId: number, jobIds: number[], profileIds: number[]): void {
  const db = getDb();
  const ins = db.prepare('INSERT INTO run_items (run_id, job_id, profile_id, step) VALUES (?, ?, ?, ?)');
  db.transaction(() => {
    for (const j of jobIds) {
      ins.run(runId, j, null, 'prepare');
      for (const p of profileIds) ins.run(runId, j, p, 'match');
    }
  })();
}

/** Items a (re)started run still has to do. Items whose job or profile was deleted are dropped by the FK cascade. */
export function unfinishedItems(runId: number): RunItem[] {
  return (
    getDb()
      .prepare("SELECT * FROM run_items WHERE run_id = ? AND status IN ('pending', 'failed', 'blocked') ORDER BY job_id, step DESC, profile_id")
      .all(runId) as any[]
  ).map((r) => ({ id: r.id, runId: r.run_id, jobId: r.job_id, profileId: r.profile_id, step: r.step, status: r.status, outcome: r.outcome }));
}

export function finishItem(id: number, f: { status: ItemStatus; outcome?: string | null; error?: string | null; costUsd?: number }): void {
  getDb()
    .prepare('UPDATE run_items SET status = ?, outcome = ?, error = ?, attempts = attempts + 1, cost_usd = cost_usd + ?, updated_at = ? WHERE id = ?')
    .run(f.status, f.outcome ?? null, f.error ?? null, f.costUsd ?? 0, nowIso(), id);
}

export interface RunItemSummary {
  counts: { step: string; status: ItemStatus; outcome: string | null; n: number }[];
  errors: AnalyzeItemError[];
}

export function summarizeRunItems(runId: number): RunItemSummary {
  const db = getDb();
  const counts = db.prepare('SELECT step, status, outcome, COUNT(*) AS n FROM run_items WHERE run_id = ? GROUP BY step, status, outcome').all(runId) as RunItemSummary['counts'];
  const errors = (
    db
      .prepare(
        `SELECT i.id, i.job_id, i.step, i.status, i.error, j.title, j.company_name, p.name AS profile_name
         FROM run_items i LEFT JOIN jobs j ON j.id = i.job_id LEFT JOIN profiles p ON p.id = i.profile_id
         WHERE i.run_id = ? AND i.status = 'failed' ORDER BY i.updated_at DESC LIMIT 100`,
      )
      .all(runId) as any[]
  ).map(
    (r): AnalyzeItemError => ({
      itemId: r.id,
      jobId: r.job_id,
      jobTitle: r.title,
      companyName: r.company_name,
      profileName: r.profile_name,
      step: r.step,
      status: r.status,
      error: r.error ?? 'Unknown error',
    }),
  );
  return { counts, errors };
}

// ---- Candidate jobs -------------------------------------------------------------------------

export interface CandidateJob {
  id: number;
  sourceKey: string;
  postedAt: string | null;
  firstSeenAt: string;
  isClosed: boolean;
  fetchStatus: string;
  hasDescription: boolean;
  extractionId: number | null;
}

export function listCandidateRows(jobIds: number[] | null): CandidateJob[] {
  const db = getDb();
  const cols = `id, source_key, posted_at, first_seen_at, is_closed, fetch_status, extraction_id,
    (description_text IS NOT NULL AND TRIM(description_text) <> '') AS has_description`;
  const rows = (jobIds ? jobIds.map((id) => db.prepare(`SELECT ${cols} FROM jobs WHERE id = ?`).get(id)).filter(Boolean) : db.prepare(`SELECT ${cols} FROM jobs`).all()) as any[];
  return rows.map((r) => ({
    id: r.id,
    sourceKey: r.source_key,
    postedAt: r.posted_at,
    firstSeenAt: r.first_seen_at,
    isClosed: r.is_closed === 1,
    fetchStatus: r.fetch_status,
    hasDescription: !!r.has_description,
    extractionId: r.extraction_id ?? null,
  }));
}

/** Total LLM spend since the start of the current (local) month. */
export function monthSpend(now: Date): number {
  const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const r = getDb().prepare('SELECT COALESCE(SUM(cost_usd), 0) AS s FROM usage_log WHERE created_at >= ?').get(start) as { s: number };
  return r.s;
}

/** Average tokens per call for a task + model over recent history. */
export function averageUsage(task: string, modelId: number): { calls: number; input: number; cached: number; output: number } {
  const r = getDb()
    .prepare(
      `SELECT COUNT(*) AS calls, AVG(input_tokens) AS input, AVG(cached_tokens) AS cached, AVG(output_tokens) AS output
       FROM (SELECT input_tokens, cached_tokens, output_tokens FROM usage_log WHERE task = ? AND model_id = ? ORDER BY id DESC LIMIT 200)`,
    )
    .get(task, modelId) as { calls: number; input: number | null; cached: number | null; output: number | null };
  return { calls: r.calls, input: r.input ?? 0, cached: r.cached ?? 0, output: r.output ?? 0 };
}
