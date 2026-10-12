import type { TaskKey } from '@shared/tasks';
import type { JobExtraction } from '@shared/llm-schemas';
import type { MatchOutcome, PrepareOutcome } from '@shared/analysis';
import { snapToTaxonomy, type Taxonomy, type TaxonomyField } from '@shared/taxonomy';
import { evaluateHardFilters, normalizePeriod } from '@shared/hardFilters';
import { canonicalCountry } from '@shared/geo';
import { normalizeTechList } from '@shared/tech';
import type { HardFilters } from '@shared/profile';
import type { HttpClient } from '../net/http';
import { LlmConfigError, runTask } from '../llm';
import type { TemplateVars } from '../llm/template';
import { getRoute } from '../repos/routes';
import { getActivePrompt } from '../repos/prompts';
import { getProfile } from '../repos/profiles';
import { applyFetchedJob } from '../repos/jobs';
import {
  findAnalysis,
  findExtraction,
  getExtraction,
  getJobForAnalysis,
  markClosed,
  markUnreadable,
  noLongerListed,
  saveExtraction,
  saveFetchedText,
  setTitleIfMissing,
  upsertAnalysis,
  useExtraction,
  type AnalysisKey,
  type JobForAnalysis,
} from '../repos/analysis';
import { profileTemplateVars } from '../resume/vars';
import { closedPhrase, looksOdd } from './closed';
import { fetchDescription, type FetchVia, type PageRenderer } from './fetch';

/**
 * The analysis pipeline (§5): per job (once) — get description, closed detection, job extraction;
 * per job × profile — hard filters, optional pre-score, matching. Every step checks its cache
 * first, so re-running costs nothing for work already done.
 */

export interface StepDeps {
  http: HttpClient;
  render: PageRenderer | null;
  now: () => Date;
  signal?: AbortSignal;
  runId: number | null;
}

export interface StepResult<O> {
  outcome: O;
  costUsd: number;
  detail?: string | null;
}

/** The model an extraction/analysis is cached under: the route's model (or its fallback when no model is set). */
export function routeKeyModel(task: TaskKey): number {
  const r = getRoute(task);
  const id = r?.model_id ?? r?.fallback_model_id;
  if (id == null) throw new LlmConfigError(`No model selected for task "${task}" (Settings → Task routing).`);
  return id;
}

export function activePromptId(task: TaskKey): number {
  const p = getActivePrompt(task);
  if (!p) throw new LlmConfigError(`No active prompt for task "${task}".`);
  return p.id;
}

/** Real postings stay well under this (99% are below 14k characters); longer pages are mostly unrelated listings. */
const MAX_JOB_TEXT = 20_000;

/** {{job_text}}: a short header with what we know, then the description. */
export function jobPromptText(job: Pick<JobForAnalysis, 'title' | 'companyName' | 'location' | 'description'>): string {
  const head = [job.title && `Title: ${job.title}`, job.companyName && `Company: ${job.companyName}`, job.location && `Location: ${job.location}`].filter(Boolean).join('\n');
  let body = (job.description ?? '').trim();
  if (body.length > MAX_JOB_TEXT) body = `${body.slice(0, MAX_JOB_TEXT)}\n[…truncated]`;
  return head ? `${head}\n\n${body}` : body;
}

/** {{job_fields}}: the extracted fields plus title/company/location, as compact JSON (it's per-job, so never cached). */
export function jobFieldsText(job: Pick<JobForAnalysis, 'title' | 'companyName' | 'location'>, fields: JobExtraction): string {
  const { job_title, company_name, location, ...rest } = fields;
  return JSON.stringify({ title: job_title ?? job.title, company: job.companyName ?? company_name, location: location ?? job.location, ...rest });
}

function cleanList(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const v = raw.replace(/\s+/g, ' ').trim();
    if (!v || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    out.push(v);
  }
  return out;
}

const blank = (s: string | null) => (s && s.trim() && !/^(unknown|n\/a|none|null|not (?:stated|specified|mentioned))$/i.test(s.trim()) ? s.trim() : null);
const nonNeg = (n: number | null) => (n != null && Number.isFinite(n) && n >= 0 ? n : null);

/** Snap enums onto the taxonomy, normalise names, numbers and lists (never invent values). */
export function cleanExtraction(raw: JobExtraction, taxonomy: Taxonomy): JobExtraction {
  const snap = (f: TaxonomyField, v: unknown) => snapToTaxonomy(taxonomy, f, v);
  let min = nonNeg(raw.salary_min);
  let max = nonNeg(raw.salary_max);
  if (min != null && max != null && min > max) [min, max] = [max, min];
  const currency = blank(raw.salary_currency)?.toUpperCase() ?? null;
  const years = nonNeg(raw.required_years);
  return {
    job_title: blank(raw.job_title)?.replace(/\s+/g, ' ') ?? null,
    company_name: blank(raw.company_name)?.replace(/\s+/g, ' ') ?? null,
    location: blank(raw.location)?.replace(/\s+/g, ' ') ?? null,
    job_function: snap('job_function', raw.job_function),
    seniority: snap('seniority', raw.seniority),
    industry: snap('industry', raw.industry),
    company_stage: snap('company_stage', raw.company_stage),
    work_mode: snap('work_mode', raw.work_mode),
    remote_region: blank(raw.remote_region),
    employment_type: snap('employment_type', raw.employment_type),
    country: canonicalCountry(blank(raw.country)),
    city: blank(raw.city),
    salary_min: min,
    salary_max: max,
    salary_currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : null,
    salary_period: normalizePeriod(raw.salary_period),
    salary_listed: !!raw.salary_listed && (min != null || max != null),
    visa_sponsorship: snap('visa_sponsorship', raw.visa_sponsorship),
    required_years: years != null && years <= 60 ? years : null,
    required_languages: cleanList(raw.required_languages),
    must_have_skills: cleanList(raw.must_have_skills),
    nice_to_have_skills: cleanList(raw.nice_to_have_skills),
    tech_stack: normalizeTechList(raw.tech_stack),
    problem_domains: cleanList(raw.problem_domains),
    responsibilities: cleanList(raw.responsibilities),
  };
}

const modelLabel = (r: { model: { display_name: string }; usedFallback: boolean }) => (r.usedFallback ? `${r.model.display_name} (fallback)` : r.model.display_name);

// ---- Per job --------------------------------------------------------------------------------

export async function prepareJob(jobId: number, deps: StepDeps, taxonomy: Taxonomy): Promise<StepResult<PrepareOutcome>> {
  let job = getJobForAnalysis(jobId);
  if (!job) throw new Error('The job was deleted.');
  if (job.isClosed) return { outcome: 'closed', costUsd: 0 };
  let cost = 0;
  let freshVia: FetchVia | null = null;

  // 1. Description via the fetch ladder.
  if (!job.description) {
    if (job.fetchStatus === 'unreadable') return { outcome: 'needs_text', costUsd: 0, detail: 'waiting for a pasted description' };
    const res = await fetchDescription(job.url, { http: deps.http, render: deps.render, signal: deps.signal, now: deps.now() });
    if (res.kind === 'closed') {
      markClosed(jobId, res.reason);
      return { outcome: 'closed', costUsd: 0, detail: res.reason };
    }
    if (res.kind === 'unreadable') {
      markUnreadable(jobId, job.url, res.reason);
      return { outcome: 'needs_text', costUsd: 0, detail: res.reason };
    }
    if (res.raw) applyFetchedJob(jobId, { ...res.raw, descriptionText: res.text }, res.rawSourceKey ?? job.sourceKey);
    saveFetchedText(jobId, res.text);
    setTitleIfMissing(jobId, res.pageTitle);
    freshVia = res.via;
    job = getJobForAnalysis(jobId)!;
  }

  // 2. Closed detection: rules first, the LLM only when they're inconclusive and the text looks odd.
  const text = job.description!;
  const phrase = closedPhrase(text);
  if (phrase) {
    markClosed(jobId, `The posting says "${phrase}"`);
    return { outcome: 'closed', costUsd: 0 };
  }
  if (noLongerListed(job)) {
    markClosed(jobId, 'No longer listed: the latest collection from this company did not include it');
    return { outcome: 'closed', costUsd: 0 };
  }
  if (freshVia && freshVia !== 'ats' && looksOdd(text)) {
    const r = await runTask('closed_check', { job_text: jobPromptText(job) }, { runId: deps.runId, signal: deps.signal });
    cost += r.usage.costUsd;
    if (r.data.status === 'closed') {
      markClosed(jobId, `Closed check: ${r.data.reason}`);
      return { outcome: 'closed', costUsd: cost };
    }
    if (r.data.status === 'not_a_job_page') {
      markUnreadable(jobId, job.url, `Not a job posting page (closed check: ${r.data.reason})`);
      return { outcome: 'needs_text', costUsd: cost, detail: r.data.reason };
    }
  }

  // 3. Job extraction, cached per job + prompt version + model.
  const promptId = activePromptId('job_extraction');
  const modelKey = routeKeyModel('job_extraction');
  const cached = findExtraction(jobId, promptId, modelKey);
  if (cached) {
    if (job.extractionId !== cached.id) useExtraction(jobId, cached.id);
    return { outcome: 'cached', costUsd: cost };
  }
  const r = await runTask('job_extraction', { job_text: jobPromptText(job) }, { runId: deps.runId, signal: deps.signal });
  cost += r.usage.costUsd;
  saveExtraction(jobId, {
    promptVersionId: r.promptVersionId,
    modelId: modelKey,
    usedModelId: r.model.id,
    modelName: modelLabel(r),
    fields: cleanExtraction(r.data, taxonomy),
    costUsd: r.usage.costUsd,
  });
  return { outcome: 'extracted', costUsd: cost };
}

// ---- Per job × profile ----------------------------------------------------------------------

export interface ProfileContext {
  profileId: number;
  name: string;
  resumeId: number;
  hard: HardFilters;
  vars: TemplateVars;
}

/** Everything the matching step needs about a profile. Throws when it has no parsed resume. */
export function loadProfileContext(profileId: number): ProfileContext {
  const p = getProfile(profileId);
  const { vars, resumeId } = profileTemplateVars(profileId);
  return { profileId, name: p.name, resumeId, hard: p.preferences.hard, vars };
}

export interface MatchOptions {
  reanalyze: boolean;
  preScore: { enabled: boolean; threshold: number };
  taxonomy: Taxonomy;
}

export async function matchJob(jobId: number, profile: ProfileContext, deps: StepDeps, opts: MatchOptions): Promise<StepResult<MatchOutcome>> {
  const job = getJobForAnalysis(jobId);
  if (!job) throw new Error('The job was deleted.');
  if (job.isClosed) return { outcome: 'job_closed', costUsd: 0 };
  const ex = job.extractionId != null ? getExtraction(job.extractionId) : null;
  if (!ex) throw new Error("The job's fields haven't been extracted yet.");

  // 4. Hard filters: pure code, re-checked every run (preferences may have changed).
  const jobText = jobPromptText(job);
  const hard = evaluateHardFilters(profile.hard, ex.fields, jobText, opts.taxonomy.seniority);
  const key: AnalysisKey = {
    jobId,
    profileId: profile.profileId,
    resumeId: profile.resumeId,
    promptVersionId: activePromptId('matching'),
    modelId: routeKeyModel('matching'),
  };
  const existing = findAnalysis(key);
  const base = { extractionId: ex.id, hard, runId: deps.runId };

  if (!hard.pass) {
    upsertAnalysis(key, { ...base, outcome: existing?.hasMatch ? 'matched' : existing?.outcome === 'pre_score_skip' ? 'pre_score_skip' : 'hard_filter' });
    return { outcome: 'hard_filter', costUsd: 0, detail: hard.reasons.join('; ') };
  }

  // Caching rule: an analysis with this key exists → no LLM call unless re-analyze is on.
  if (existing && !opts.reanalyze) {
    const skipStillApplies = existing.outcome === 'pre_score_skip' && opts.preScore.enabled && existing.preScore != null && existing.preScore < opts.preScore.threshold;
    if (existing.hasMatch || skipStillApplies) {
      upsertAnalysis(key, { ...base, outcome: existing.hasMatch ? 'matched' : 'pre_score_skip' });
      return { outcome: 'cached', costUsd: 0 };
    }
  }

  const fieldsText = jobFieldsText(job, ex.fields);
  let cost = 0;

  // 5. Optional quick pre-score.
  let pre: { score: number; reason: string } | undefined;
  if (opts.preScore.enabled) {
    if (existing?.preScore != null && !opts.reanalyze) {
      pre = { score: existing.preScore, reason: existing.preScoreReason ?? '' };
    } else {
      const r = await runTask('pre_score', { profile_structured: profile.vars.profile_structured, job_fields: fieldsText }, { runId: deps.runId, signal: deps.signal });
      cost += r.usage.costUsd;
      pre = { score: Math.round(r.data.score), reason: r.data.reason };
      if (pre.score < opts.preScore.threshold) {
        upsertAnalysis(key, { ...base, outcome: 'pre_score_skip', preScore: pre, match: null, usedModelId: r.model.id, modelName: `${modelLabel(r)} (pre-score)`, addCostUsd: cost });
        return { outcome: 'pre_score_skip', costUsd: cost, detail: pre.reason };
      }
    }
    if (pre.score < opts.preScore.threshold) {
      upsertAnalysis(key, { ...base, outcome: 'pre_score_skip', preScore: pre, match: null });
      return { outcome: 'pre_score_skip', costUsd: cost, detail: pre.reason };
    }
  }

  // 6. Matching. The total and verdict are computed in code from the sub-scores, never by the LLM.
  const r = await runTask('matching', { ...profile.vars, job_fields: fieldsText, job_text: jobText }, { runId: deps.runId, signal: deps.signal });
  cost += r.usage.costUsd;
  upsertAnalysis(key, {
    ...base,
    outcome: 'matched',
    ...(pre ? { preScore: pre } : {}),
    match: r.data,
    usedModelId: r.model.id,
    modelName: modelLabel(r),
    addCostUsd: cost,
  });
  return { outcome: 'matched', costUsd: cost };
}
