import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderRequest, ProviderResponse } from '../src/main/llm/types';
import { ClosedCheckSchema, JobExtractionSchema, MatchResultSchema, PreScoreSchema } from '../src/shared/llm-schemas';

// ---- Mocked LLM providers: answer by the requested output schema ---------------------------

type Call = { provider: string; task: string; text: string };
const calls: Call[] = [];
let gate: Promise<void> | null = null;

const taskOf = (req: ProviderRequest) =>
  req.schema === JobExtractionSchema ? 'job_extraction' : req.schema === MatchResultSchema ? 'matching' : req.schema === PreScoreSchema ? 'pre_score' : req.schema === ClosedCheckSchema ? 'closed_check' : 'other';

let extractionOver: Record<string, unknown> = {};
const extraction = (over: Record<string, unknown> = {}) => ({
  job_title: null,
  company_name: null,
  location: null,
  job_function: 'Backend',
  seniority: 'Senior',
  industry: 'Fintech',
  company_stage: 'unknown',
  work_mode: 'Onsite',
  remote_region: null,
  employment_type: 'Full-time',
  country: 'USA',
  city: 'New York',
  salary_min: null,
  salary_max: null,
  salary_currency: null,
  salary_period: null,
  salary_listed: false,
  visa_sponsorship: 'Not mentioned',
  required_years: 5,
  required_languages: ['English'],
  must_have_skills: ['Go'],
  nice_to_have_skills: [],
  tech_stack: ['golang', 'Postgres'],
  problem_domains: ['payments'],
  responsibilities: ['Build APIs'],
  ...extractionOver,
  ...over,
});

const MATCH = {
  sub_scores: {
    skills: { score: 90, reason: 'Go' },
    domain_fit: { score: 80, reason: 'payments' },
    project_similarity: { score: 70, reason: 'ledger' },
    experience_fit: { score: 80, reason: '8 years' },
    preferences_fit: { score: 60, reason: 'ok' },
  },
  strengths: [{ point: 'Go services', resume_evidence: 'built a ledger in Go' }],
  gaps: [{ point: 'no Kafka', severity: 'low' }],
  summary: 'Strong backend fit',
};

let preScore = 20;
function answer(req: ProviderRequest): string {
  const text = req.parts.map((p) => p.text).join('');
  switch (taskOf(req)) {
    case 'job_extraction':
      return JSON.stringify(text.includes('Paris') ? extraction({ country: 'France', city: 'Paris' }) : extraction());
    case 'matching':
      return JSON.stringify(MATCH);
    case 'pre_score':
      return JSON.stringify({ score: preScore, reason: 'Different stack' });
    case 'closed_check':
      return JSON.stringify({ status: 'open', reason: 'Accepting applications' });
    default:
      throw new Error('unexpected request');
  }
}

function scripted(provider: string) {
  return {
    async complete(req: ProviderRequest): Promise<ProviderResponse> {
      calls.push({ provider, task: taskOf(req), text: req.parts.map((p) => p.text).join('') });
      if (gate) {
        // Block until cancelled, like a slow provider call.
        await new Promise<void>((_, reject) => req.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
      }
      return { text: answer(req), usage: { uncachedInput: 1000, cacheWrite: 0, cachedInput: 0, output: 200 }, stopReason: 'stop' };
    },
    async test() {
      return 'ok';
    },
  };
}

vi.mock('../src/main/llm/anthropic', () => ({ anthropicAdapter: scripted('anthropic') }));
vi.mock('../src/main/llm/openai-compat', () => ({ makeOpenAICompatAdapter: (flavor: string) => scripted(flavor) }));

const { setupTestDb } = await import('./helpers');
const { fakeHttp } = await import('./fakeHttp');
const { getDb } = await import('../src/main/db');
const { setKey } = await import('../src/main/repos/keys');
const { addLinks, upsertCollectedJob, getJobItem } = await import('../src/main/repos/jobs');
const { createProfile, createResume, saveParseResult, savePreferences } = await import('../src/main/repos/profiles');
const { createPromptVersion } = await import('../src/main/repos/prompts');
const { updateSettings } = await import('../src/main/repos/settings');
const { addCompany } = await import('../src/main/repos/companies');
const { addSourceHealth, createRun, getRun } = await import('../src/main/repos/runs');
const { listNeedsPaste, listRunAnalyses, savePastedText } = await import('../src/main/repos/analysis');
const { DEFAULT_PREFERENCES } = await import('../src/shared/profile');
const { DEFAULT_THRESHOLDS, DEFAULT_WEIGHTS } = await import('../src/shared/scoring');
const { analyzeState, cancelAnalyze, estimate, resumeAnalyze, startAnalyze, BudgetExceededError } = await import('../src/main/runs/analyze');
const { SEED_PROMPTS } = await import('../src/main/seed/prompts');

const DESC =
  'About the role: build payment APIs in Go and PostgreSQL. Responsibilities: design services, own reliability, mentor engineers. ' +
  'Requirements: 5+ years of backend experience and distributed systems. Benefits: health, equity and a remote stipend. '.repeat(3);

const STRUCTURED = {
  name: 'Alex',
  headline: 'Backend engineer',
  total_years_experience: 8,
  skills: ['Go', 'PostgreSQL'],
  roles: [],
  projects: [],
  domains: ['payments'],
  education: [],
  languages: ['English'],
};

let profileId: number;

function addProfile(name: string, countries: string[] = ['United States']): number {
  const id = createProfile(name);
  const prefs = structuredClone(DEFAULT_PREFERENCES);
  prefs.hard.location = { enabled: true, countries, cities: [] };
  savePreferences(id, prefs);
  const rid = createResume(id, { fileName: 'cv.txt', kind: 'txt', blob: null, text: 'Alex — built a ledger in Go' });
  saveParseResult(rid, STRUCTURED, 1, 1, 'test');
  return id;
}

let n = 0;
function collected(over: { title?: string; location?: string; description?: string; companyId?: number | null; sourceKey?: string; postedAt?: string } = {}): number {
  n++;
  return upsertCollectedJob(
    {
      url: `https://job-boards.greenhouse.io/acme/jobs/${n}`,
      externalId: String(n),
      title: over.title ?? `Backend Engineer ${n}`,
      companyName: 'Acme',
      location: over.location ?? 'New York, NY',
      postedAt: over.postedAt ?? new Date().toISOString(),
      postedAtSource: 'source',
      descriptionText: over.description ?? DESC,
    },
    { sourceKey: over.sourceKey ?? 'greenhouse', companyId: over.companyId ?? null, now: new Date().toISOString(), insertIfNew: true },
  ).jobId!;
}

const params = (over: Record<string, unknown> = {}) => ({
  profileIds: [profileId],
  dateRange: { preset: 'last30' as const, from: null, to: null },
  dateField: 'posted' as 'posted' | 'added',
  sourceKeys: [],
  reanalyze: false,
  jobIds: null,
  ...over,
});

const deps = (routes: Parameters<typeof fakeHttp>[0] = {}) => ({ http: fakeHttp(routes), render: null, now: () => new Date(), concurrency: 2 });
const count = (task: string) => calls.filter((c) => c.task === task).length;

beforeEach(() => {
  setupTestDb();
  calls.length = 0;
  extractionOver = {};
  gate = null;
  preScore = 20;
  n = 0;
  for (const p of ['deepseek', 'anthropic', 'openai'] as const) setKey({ provider: p, key: `${p}-key-123456` });
  profileId = addProfile('Alex');
});

describe('analyze run', () => {
  it('extracts, filters, matches; closed jobs cost nothing; totals are computed in code', async () => {
    const open = collected({ title: 'Backend Engineer' });
    const closed = collected({ title: 'Platform Engineer', description: `This job is no longer accepting applications. ${DESC}` });
    const paris = collected({ title: 'Go Engineer', location: 'Paris, France', description: `Based in Paris. ${DESC}` });

    const { runId, done } = startAnalyze({ params: params(), budgetOverride: false }, deps());
    await done;

    expect(count('job_extraction')).toBe(2); // not for the closed job
    expect(count('matching')).toBe(1); // Paris fails the location hard filter, closed job skipped
    expect(calls.filter((c) => c.task === 'matching').every((c) => !c.text.includes('Platform Engineer'))).toBe(true);
    expect(getJobItem(closed)).toMatchObject({ isClosed: true, closedReason: expect.stringMatching(/no longer accepting/) });

    const state = analyzeState().last!;
    expect(state).toMatchObject({ runId, status: 'completed', jobs: { total: 3, finished: 3 }, matches: { total: 3, finished: 3 }, failed: 0, remaining: 0 });
    expect(state.prepareOutcomes).toEqual({ extracted: 2, closed: 1 });
    expect(state.matchOutcomes).toEqual({ matched: 1, hard_filter: 1, job_closed: 1 });
    expect(state.costUsd).toBeGreaterThan(0);

    const rows = listRunAnalyses(runId, DEFAULT_WEIGHTS, DEFAULT_THRESHOLDS);
    const matched = rows.find((r) => r.jobId === open)!;
    // (90×25 + 80×25 + 70×25 + 80×15 + 60×10) / 100 = 78
    expect(matched).toMatchObject({ outcome: 'matched', total: 78, verdict: 'good', summary: 'Strong backend fit' });
    expect(rows.find((r) => r.jobId === paris)).toMatchObject({ outcome: 'hard_filter', hardFilterReasons: [expect.stringMatching(/Paris, France/)] });

    // Extraction is normalised and indexed.
    const ex = getDb().prepare('SELECT e.country, e.company_stage, j.extraction_id FROM jobs j JOIN job_extractions e ON e.id = j.extraction_id WHERE j.id = ?').get(open) as any;
    expect(ex).toMatchObject({ country: 'United States', company_stage: 'Unknown' });
    const tech = (getDb().prepare("SELECT tag FROM job_tags WHERE job_id = ? AND tag_type = 'tech' ORDER BY tag").all(open) as any[]).map((r) => r.tag);
    expect(tech).toEqual(['Go', 'PostgreSQL']);
  });

  it('running the same analysis twice makes no new LLM calls; a new matching prompt version does', async () => {
    collected();
    collected();
    await startAnalyze({ params: params(), budgetOverride: false }, deps()).done;
    const first = calls.length;
    expect(count('matching')).toBe(2);

    const est = estimate(params());
    expect(est).toMatchObject({ needExtraction: 0, needMatching: 0, cached: 2, totalUsd: 0 });
    await startAnalyze({ params: params(), budgetOverride: false }, deps()).done;
    expect(calls.length).toBe(first);
    expect(analyzeState().last!.matchOutcomes).toEqual({ cached: 2 });

    createPromptVersion('matching', `${SEED_PROMPTS.matching}\nBe extra strict.`, 'v2', true);
    await startAnalyze({ params: params(), budgetOverride: false }, deps()).done;
    expect(count('matching')).toBe(4);
    expect(count('job_extraction')).toBe(2); // extractions stay cached
  });

  it('the date range applies to the posting date or to the day the job was added', () => {
    collected();
    collected({ postedAt: new Date(Date.now() - 60 * 86400_000).toISOString() }); // posted long ago, added today
    expect(estimate(params()).jobs).toBe(1);
    expect(estimate(params({ dateField: 'added' })).jobs).toBe(2);
  });

  it('re-analyze is opt-in', async () => {
    collected();
    await startAnalyze({ params: params(), budgetOverride: false }, deps()).done;
    await startAnalyze({ params: params({ reanalyze: true }), budgetOverride: false }, deps()).done;
    expect(count('matching')).toBe(2);
  });

  it('unreadable links go to the manual-paste queue; pasted text is analyzed normally on resume', async () => {
    addLinks('https://www.linkedin.com/jobs/view/backend-engineer-at-acme-3812345678');
    const http = { 'https://linkedin.com/jobs/view/3812345678': '<html><body><p>Sign in to view this job.</p></body></html>' };
    const { runId, done } = startAnalyze({ params: params(), budgetOverride: false }, deps(http));
    await done;
    expect(calls).toHaveLength(0);
    const [job] = listNeedsPaste();
    expect(job).toMatchObject({ fetchStatus: 'unreadable', fetchError: expect.stringMatching(/login wall/) });
    expect(analyzeState().last).toMatchObject({ remaining: 2, blocked: 2, prepareOutcomes: { needs_text: 1 }, matchOutcomes: { needs_text: 1 } });
    expect(getDb().prepare('SELECT domain FROM unreadable_log').all()).toEqual([{ domain: 'linkedin.com' }]);

    savePastedText(job.id, `Backend Engineer at Acme, New York. ${DESC}`);
    expect(listNeedsPaste()).toHaveLength(0);
    await resumeAnalyze(runId, deps(http)).done;
    expect(count('job_extraction')).toBe(1);
    expect(count('matching')).toBe(1);
    expect(getJobItem(job.id)).toMatchObject({ fetchStatus: 'manual_text' });
    expect(analyzeState().last).toMatchObject({ status: 'completed', remaining: 0, matchOutcomes: { matched: 1 } });
  });

  it("pasted links take the posting's own title, company and location; older extractions are redone", async () => {
    addLinks('https://ats.rippling.com/free-market-health/jobs/5e89b906');
    const html = `<html><head><title>Sr. Software Engineer, Team Lead | Free Market Health's Open Positions</title></head><body><main><h1>Sr. Software Engineer, Team Lead</h1><p>${DESC}</p></main></body></html>`;
    extractionOver = { job_title: 'Sr. Software Engineer, Team Lead', company_name: 'Free Market Health', location: 'Tampa, FL', work_mode: 'Hybrid' };
    await startAnalyze({ params: params(), budgetOverride: false }, deps({ 'https://ats.rippling.com/free-market-health/jobs/5e89b906': html })).done;
    const [{ id }] = getDb().prepare('SELECT id FROM jobs').all() as { id: number }[];
    expect(getJobItem(id)).toMatchObject({ title: 'Sr. Software Engineer, Team Lead', companyName: 'Free Market Health', location: 'Tampa, FL' });
    expect(estimate(params()).needExtraction).toBe(0);

    // An extraction saved before these fields existed counts as missing, so the next run redoes it.
    getDb().prepare("UPDATE job_extractions SET fields_json = json_remove(fields_json, '$.job_title', '$.company_name', '$.location')").run();
    expect(estimate(params())).toMatchObject({ needExtraction: 1, needMatching: 0 });
    await startAnalyze({ params: params(), budgetOverride: false }, deps()).done;
    expect(count('job_extraction')).toBe(2);
    expect(count('matching')).toBe(1); // the match stays cached
  });

  it('fetches missing descriptions through the ladder and stores the structured data', async () => {
    addLinks('https://jobright.ai/jobs/info/abc');
    const ld = JSON.stringify({ '@type': 'JobPosting', title: 'Staff Engineer', description: DESC, datePosted: '2026-09-28', hiringOrganization: { name: 'Globex' } });
    const http = { 'https://jobright.ai/jobs/info/abc': `<html><head><script type="application/ld+json">${ld}</script></head><body></body></html>` };
    await startAnalyze({ params: params(), budgetOverride: false }, deps(http)).done;
    const [job] = getDb().prepare('SELECT id FROM jobs').all() as { id: number }[];
    expect(getJobItem(job.id)).toMatchObject({ title: 'Staff Engineer', companyName: 'Globex', fetchStatus: 'fetched', postedAtSource: 'source' });
    expect(count('matching')).toBe(1);
  });

  it('marks jobs the ATS no longer lists as closed', async () => {
    const company = addCompany({ name: 'Acme', careersUrl: 'https://job-boards.greenhouse.io/acme', atsType: 'greenhouse', boardToken: 'acme' });
    const job = collected({ companyId: company });
    // A later successful collection of Acme that did not include the job.
    const later = createRun('collect', {}, 1);
    getDb().prepare('UPDATE runs SET started_at = ? WHERE id = ?').run(new Date(Date.now() + 60_000).toISOString(), later);
    addSourceHealth({ runId: later, sourceKey: 'greenhouse', companyId: company, label: 'Acme', jobsFound: 5, jobsInRange: 0, jobsNew: 0, status: 'ok', error: null, durationMs: 1 });
    await startAnalyze({ params: params(), budgetOverride: false }, deps()).done;
    expect(getJobItem(job)).toMatchObject({ isClosed: true, closedReason: expect.stringMatching(/No longer listed/) });
    expect(calls).toHaveLength(0);
  });

  it('optional pre-score skips weak matches before matching', async () => {
    updateSettings({ preScore: { enabled: true, threshold: 40 } });
    collected();
    await startAnalyze({ params: params(), budgetOverride: false }, deps()).done;
    expect(count('pre_score')).toBe(1);
    expect(count('matching')).toBe(0);
    expect(analyzeState().last!.matchOutcomes).toEqual({ pre_score_skip: 1 });
    // Still cached on the next run: no new calls.
    await startAnalyze({ params: params(), budgetOverride: false }, deps()).done;
    expect(count('pre_score')).toBe(1);
    // Turning pre-score off sends it to matching.
    updateSettings({ preScore: { enabled: false, threshold: 40 } });
    await startAnalyze({ params: params(), budgetOverride: false }, deps()).done;
    expect(count('matching')).toBe(1);
  });

  it('blocks runs over the monthly budget unless overridden', async () => {
    collected();
    updateSettings({ monthlyBudgetUsd: 0.000001 });
    const est = estimate(params());
    expect(est.exceedsBudget).toBe(true);
    expect(est.tasks.find((t) => t.task === 'matching')).toMatchObject({ calls: 1, basis: 'default', inputTokens: 5000, outputTokens: 900 });
    expect(() => startAnalyze({ params: params(), budgetOverride: false }, deps())).toThrow(BudgetExceededError);
    await startAnalyze({ params: params(), budgetOverride: true }, deps()).done;
    expect(count('matching')).toBe(1);
  });

  it('cancel leaves work pending; resume finishes it', async () => {
    collected();
    collected();
    gate = Promise.resolve();
    const { runId, done } = startAnalyze({ params: params(), budgetOverride: false }, deps());
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
    cancelAnalyze(runId);
    await done;
    expect(getRun(runId)!.status).toBe('cancelled');
    expect(analyzeState().last!.remaining).toBe(4);

    gate = null;
    await resumeAnalyze(runId, deps()).done;
    expect(analyzeState().last).toMatchObject({ status: 'completed', remaining: 0, failed: 0, matchOutcomes: { matched: 2 } });
  });

  it('records per-item failures without failing the run', async () => {
    collected();
    const other = addProfile('Sam');
    // Sam's resume isn't parsed yet → refuse up front with a clear message.
    createResume(other, { fileName: 'cv2.txt', kind: 'txt', blob: null, text: 'Sam' });
    expect(() => startAnalyze({ params: params({ profileIds: [profileId, other] }), budgetOverride: false }, deps())).toThrow(/Sam.*hasn't been parsed/);

    // A provider failure on one item: the run completes and reports it.
    getDb().prepare('DELETE FROM api_keys').run();
    await startAnalyze({ params: params(), budgetOverride: false }, deps()).done;
    const s = analyzeState().last!;
    expect(s.status).toBe('completed');
    expect(s.failed).toBe(1);
    expect(s.errors[0]).toMatchObject({ step: 'prepare', error: expect.stringMatching(/No API key/) });
  });
});
