import { beforeEach, describe, expect, it } from 'vitest';
import { setupTestDb } from './helpers';
import { getDb } from '../src/main/db';
import { getJobItem, listJobs, upsertCollectedJob } from '../src/main/repos/jobs';
import { createProfile, createResume, saveParseResult } from '../src/main/repos/profiles';
import { refetchJobs, savePastedText, saveExtraction, upsertAnalysis, type AnalysisKey } from '../src/main/repos/analysis';
import { exportRows, getResultDetail, getStatus, listResults, markExported, markOpened, setFeedback, setStatuses } from '../src/main/repos/results';
import { buildClipboardTable, buildExport, exportFileName, exportWorkType, scoreRow, stripWorkMode } from '../src/shared/results';
import { DEFAULT_FILTERS, applyFilters, facetCounts, yearlySalary, type ScoredRow } from '../src/shared/resultFilters';
import { DEFAULT_THRESHOLDS, DEFAULT_WEIGHTS } from '../src/shared/scoring';
import type { JobExtraction, MatchResult } from '../src/shared/llm-schemas';
import type { HardFilterOutcome } from '../src/shared/hardFilters';

const PARSED = { name: null, headline: null, total_years_experience: 5, skills: [], roles: [], projects: [], domains: [], education: [], languages: [] };

const fields = (over: Partial<JobExtraction> = {}): JobExtraction => ({
  job_title: null,
  company_name: null,
  location: null,
  job_function: 'Backend',
  seniority: 'Senior',
  industry: 'Fintech',
  company_stage: 'Unknown',
  work_mode: 'Remote',
  remote_region: null,
  employment_type: 'Full-time',
  country: 'United States',
  city: null,
  salary_min: 150000,
  salary_max: 180000,
  salary_currency: 'USD',
  salary_period: 'year',
  salary_listed: true,
  visa_sponsorship: 'Not mentioned',
  required_years: 5,
  required_languages: ['English'],
  must_have_skills: ['Go'],
  nice_to_have_skills: [],
  tech_stack: ['Go', 'PostgreSQL'],
  problem_domains: ['payments'],
  responsibilities: ['Build APIs'],
  ...over,
});

const match = (skills: number, domain: number, summary = 'fit'): MatchResult => ({
  sub_scores: {
    skills: { score: skills, reason: 's' },
    domain_fit: { score: domain, reason: 'd' },
    project_similarity: { score: 60, reason: 'p' },
    experience_fit: { score: 60, reason: 'e' },
    preferences_fit: { score: 60, reason: 'f' },
  },
  strengths: [{ point: 'Go', resume_evidence: 'ledger in Go' }],
  gaps: [{ point: 'no Kafka', severity: 'low' }],
  summary,
});

const pass: HardFilterOutcome = { pass: true, reasons: [], results: [] };
const fail: HardFilterOutcome = { pass: false, reasons: ['Work mode Onsite not allowed'], results: [{ key: 'workModes', label: 'Work mode', status: 'fail', detail: 'Work mode Onsite not allowed' }] };

let a: number;
let b: number;
let resumeA: number;
let resumeB: number;
let n = 0;

function profile(name: string): [number, number] {
  const id = createProfile(name);
  const rid = createResume(id, { fileName: 'cv.txt', kind: 'txt', blob: null, text: 'cv' });
  saveParseResult(rid, PARSED, 1, 1, 'test');
  return [id, rid];
}

function job(title: string, f = fields()): { jobId: number; extractionId: number } {
  n++;
  const jobId = upsertCollectedJob(
    { url: `https://job-boards.greenhouse.io/acme/jobs/${n}`, externalId: String(n), title, companyName: 'Acme', location: 'Remote', postedAt: new Date().toISOString(), postedAtSource: 'source', descriptionText: 'desc' },
    { sourceKey: 'greenhouse', companyId: null, now: new Date().toISOString(), insertIfNew: true },
  ).jobId!;
  const extractionId = saveExtraction(jobId, { promptVersionId: 1, modelId: 1, usedModelId: 1, modelName: 'Flash', fields: f, costUsd: 0 });
  return { jobId, extractionId };
}

const key = (jobId: number, profileId = a, resumeId = resumeA, promptVersionId = 99): AnalysisKey => ({ jobId, profileId, resumeId, promptVersionId, modelId: 1 });

beforeEach(() => {
  setupTestDb();
  n = 0;
  [a, resumeA] = profile('Alex');
  [b, resumeB] = profile('Sam');
});

describe('analyzed profiles on the job list', () => {
  it('lists each profile a job was analyzed for, with its score or why it was not scored', () => {
    const j = job('Backend Engineer');
    const other = job('Platform Engineer');
    upsertAnalysis(key(j.jobId), { outcome: 'matched', extractionId: j.extractionId, hard: pass, runId: null, match: match(80, 80) });
    upsertAnalysis(key(j.jobId, b, resumeB), { outcome: 'hard_filter', extractionId: j.extractionId, hard: fail, runId: null });
    expect(getJobItem(j.jobId)!.analyses).toEqual([
      { profileId: a, profileName: 'Alex', status: 'scored', score: 70, verdict: 'good' },
      { profileId: b, profileName: 'Sam', status: 'filtered', score: null, verdict: null },
    ]);
    expect(listJobs().find((x) => x.id === other.jobId)!.analyses).toEqual([]);
  });
});

describe('re-fetch', () => {
  it('clears the description and extraction so the next run reads the page again; keeps scores and pasted text', () => {
    const j = job('Backend Engineer');
    upsertAnalysis(key(j.jobId), { outcome: 'matched', extractionId: j.extractionId, hard: pass, runId: null, match: match(80, 80) });
    const pasted = job('Pasted');
    savePastedText(pasted.jobId, 'a pasted description '.repeat(30));
    expect(refetchJobs([j.jobId, pasted.jobId])).toBe(1);
    expect(getDb().prepare('SELECT description_text, fetch_status, extraction_id FROM jobs WHERE id = ?').get(j.jobId)).toEqual({ description_text: null, fetch_status: 'pending', extraction_id: null });
    expect(getDb().prepare('SELECT COUNT(*) AS c FROM job_extractions WHERE job_id = ?').get(j.jobId)).toEqual({ c: 0 });
    expect(getDb().prepare('SELECT COUNT(*) AS c FROM analyses WHERE job_id = ?').get(j.jobId)).toEqual({ c: 1 });
    expect(getDb().prepare('SELECT fetch_status FROM jobs WHERE id = ?').get(pasted.jobId)).toEqual({ fetch_status: 'manual_text' });
  });
});

describe('per-profile status', () => {
  it('rejecting a job for profile A leaves it new for profile B', () => {
    const { jobId } = job('Backend Engineer');
    expect(getStatus(a, jobId)).toBe('new');
    setStatuses(a, [jobId], 'rejected');
    expect(getStatus(a, jobId)).toBe('rejected');
    expect(getStatus(b, jobId)).toBe('new');
  });

  it('opening a row moves new → reviewed only', () => {
    const { jobId } = job('Backend Engineer');
    expect(markOpened(a, jobId)).toBe('reviewed');
    setStatuses(a, [jobId], 'applied');
    expect(markOpened(a, jobId)).toBe('applied');
    expect(getStatus(b, jobId)).toBe('new');
  });

  it('feedback and export are per profile', () => {
    const { jobId } = job('Backend Engineer');
    setFeedback(a, jobId, 1, ' great ');
    markExported(a, [jobId], '2026-10-01T10:00:00.000Z');
    const row = getDb().prepare('SELECT * FROM job_profile_status WHERE job_id = ? AND profile_id = ?').get(jobId, a) as any;
    expect(row).toMatchObject({ status: 'exported', feedback: 1, feedback_note: 'great', exported_at: '2026-10-01T10:00:00.000Z' });
    expect(getDb().prepare('SELECT COUNT(*) AS c FROM job_profile_status WHERE profile_id = ?').get(b)).toEqual({ c: 0 });
  });
});

describe('results list', () => {
  it('returns one row per job: the latest analysis, preferring the current resume', () => {
    const j1 = job('Backend Engineer');
    upsertAnalysis(key(j1.jobId, a, resumeA, 1), { outcome: 'matched', extractionId: j1.extractionId, hard: pass, runId: null, match: match(50, 50, 'old prompt'), modelName: 'Sonnet' });
    upsertAnalysis(key(j1.jobId, a, resumeA, 2), { outcome: 'matched', extractionId: j1.extractionId, hard: pass, runId: null, match: match(90, 90, 'new prompt'), modelName: 'Sonnet' });
    const j2 = job('Onsite Engineer', fields({ work_mode: 'Onsite' }));
    upsertAnalysis(key(j2.jobId), { outcome: 'hard_filter', extractionId: j2.extractionId, hard: fail, runId: null });
    // Another profile's analysis doesn't show up.
    upsertAnalysis(key(j1.jobId, b, resumeA, 2), { outcome: 'matched', extractionId: j1.extractionId, hard: pass, runId: null, match: match(10, 10) });

    const list = listResults(a);
    expect(list.rows).toHaveLength(2);
    const r1 = list.rows.find((r) => r.jobId === j1.jobId)!;
    expect(r1).toMatchObject({ summary: 'new prompt', status: 'new', outcome: 'matched', hardFilterPass: true, currentResume: true });
    expect(r1.subScores).toEqual({ skills: 90, domain_fit: 90, project_similarity: 60, experience_fit: 60, preferences_fit: 60 });
    expect(r1.fields).toMatchObject({ work_mode: 'Remote', tech_stack: ['Go', 'PostgreSQL'] });
    const r2 = list.rows.find((r) => r.jobId === j2.jobId)!;
    expect(r2).toMatchObject({ outcome: 'hard_filter', hardFilterPass: false, hardFilterReasons: ['Work mode Onsite not allowed'], subScores: null });

    const d = getResultDetail(r1.analysisId);
    expect(d).toMatchObject({ summary: 'new prompt', strengths: [{ point: 'Go' }], gaps: [{ severity: 'low' }], resumeVersion: 1 });
    expect(d.subScores!.skills).toEqual({ score: 90, reason: 's' });
  });

  it('changing weights reorders results with no LLM calls', () => {
    const j1 = job('Skills-heavy');
    const j2 = job('Domain-heavy');
    upsertAnalysis(key(j1.jobId), { outcome: 'matched', extractionId: j1.extractionId, hard: pass, runId: null, match: match(100, 0) });
    upsertAnalysis(key(j2.jobId), { outcome: 'matched', extractionId: j2.extractionId, hard: pass, runId: null, match: match(0, 90) });
    const rows = listResults(a).rows;
    const order = (w: typeof DEFAULT_WEIGHTS) =>
      rows
        .map((r) => ({ title: r.title, total: scoreRow(r, w, DEFAULT_THRESHOLDS).total! }))
        .sort((x, y) => y.total - x.total)
        .map((x) => x.title);
    expect(order({ ...DEFAULT_WEIGHTS, skills: 50, domain_fit: 10 })).toEqual(['Skills-heavy', 'Domain-heavy']);
    expect(order({ ...DEFAULT_WEIGHTS, skills: 10, domain_fit: 50 })).toEqual(['Domain-heavy', 'Skills-heavy']);
    expect(getDb().prepare('SELECT COUNT(*) AS c FROM usage_log').get()).toEqual({ c: 0 });
  });
});

describe('export', () => {
  const rows = [
    { url: 'https://a.com/1', title: 'Backend, Senior', company: 'Acme "A"', workType: 'Hybrid', location: 'New York, NY', score: 82, verdict: 'strong' as const, summary: 'Line one\nline two' },
    { url: 'https://b.com/2', title: 'Platform', company: 'Beta', workType: null, location: null, score: null, verdict: null, summary: null },
  ];

  it('txt: one URL per line by default, optional columns', () => {
    expect(buildExport(rows, { format: 'txt', include: { title: false, company: false, score: false } })).toBe('https://a.com/1\nhttps://b.com/2\n');
    expect(buildExport(rows, { format: 'txt', include: { title: true, company: false, score: true } })).toBe('https://a.com/1 | Backend, Senior | 82\nhttps://b.com/2 | Platform | \n');
  });

  it('csv: header, quoting, BOM', () => {
    const csv = buildExport(rows, { format: 'csv', include: { title: false, company: false, score: false } });
    expect(csv.startsWith('﻿company,role,link,work_type,location,score,verdict,summary\r\n')).toBe(true);
    expect(csv).toContain('"Acme ""A""","Backend, Senior",https://a.com/1,Hybrid,"New York, NY",82,strong,"Line one\nline two"\r\n');
    expect(csv).toContain('Beta,Platform,https://b.com/2,,,,,\r\n');
  });

  it('clipboard rows match the job sheet: Company | Role | Link | Work type | (blank) | Location', () => {
    expect(buildClipboardTable(rows, false)).toBe('Acme "A"\tBackend, Senior\thttps://a.com/1\tHybrid\t\tNew York, NY\nBeta\tPlatform\thttps://b.com/2\t\t\t\n');
    expect(buildClipboardTable(rows, true).split('\n')[0]).toBe('Company\tRole\tLink\tWork type\t\tLocation');
  });

  it('work type and location are separate columns', () => {
    expect(exportWorkType('Remote', 'New York (Hybrid)')).toBe('Remote');
    expect(exportWorkType('Unknown', 'New York City (Hybrid)')).toBe('Hybrid');
    expect(exportWorkType(null, 'Seattle, WA (onsite)')).toBe('Onsite');
    expect(exportWorkType('Unknown', 'Boston, MA')).toBeNull();
    expect(stripWorkMode('New York City (Hybrid)')).toBe('New York City');
    expect(stripWorkMode('Seattle, WA (onsite)')).toBe('Seattle, WA');
    expect(stripWorkMode('Remote - US')).toBe('US');
    expect(stripWorkMode('Boston, MA / Remote')).toBe('Boston, MA');
    expect(stripWorkMode('Remote')).toBeNull();
    expect(stripWorkMode('Remoteville, TX')).toBe('Remoteville, TX');
  });

  it("exports the posting's location with the work mode in its own column", () => {
    const j = job('Backend | Acme Careers', fields({ job_title: 'Backend Engineer', company_name: 'Acme Corp', location: 'Austin, TX', work_mode: 'Hybrid' }));
    upsertAnalysis(key(j.jobId), { outcome: 'matched', extractionId: j.extractionId, hard: pass, runId: null, match: match(80, 80) });
    const [row] = exportRows(a, [j.jobId], DEFAULT_WEIGHTS, DEFAULT_THRESHOLDS, false).rows;
    // A collected (ATS) job keeps its source title and company; the location comes from the posting.
    expect(row).toMatchObject({ title: 'Backend | Acme Careers', company: 'Acme', workType: 'Hybrid', location: 'Austin, TX' });

    // An older extraction without a posting location falls back to the source location minus the work mode.
    const old = job('Platform', fields({ work_mode: 'Unknown' }));
    getDb().prepare("UPDATE job_extractions SET fields_json = json_remove(fields_json, '$.job_title', '$.company_name', '$.location') WHERE id = ?").run(old.extractionId);
    getDb().prepare("UPDATE jobs SET location_raw = 'New York City (Hybrid)' WHERE id = ?").run(old.jobId);
    upsertAnalysis(key(old.jobId), { outcome: 'matched', extractionId: old.extractionId, hard: pass, runId: null, match: match(80, 80) });
    expect(exportRows(a, [old.jobId], DEFAULT_WEIGHTS, DEFAULT_THRESHOLDS, false).rows[0]).toMatchObject({ workType: 'Hybrid', location: 'New York City' });
    expect(listResults(a).rows.find((r) => r.jobId === old.jobId)!.fields).not.toBeNull();
  });

  it('file name and export rows (table order, skip already exported, this profile only)', () => {
    expect(exportFileName('Alex / Backend', 'txt', new Date(2026, 9, 1))).toBe('jobs_Alex_Backend_2026-10-01.txt');
    const j1 = job('One');
    const j2 = job('Two');
    for (const j of [j1, j2]) upsertAnalysis(key(j.jobId), { outcome: 'matched', extractionId: j.extractionId, hard: pass, runId: null, match: match(80, 80) });
    markExported(a, [j1.jobId]);
    const all = exportRows(a, [j2.jobId, j1.jobId], DEFAULT_WEIGHTS, DEFAULT_THRESHOLDS, false);
    expect(all.rows.map((r) => r.title)).toEqual(['Two', 'One']);
    expect(all.rows[0]).toMatchObject({ score: 70, verdict: 'good' }) // (80×25 + 80×25 + 60×25 + 60×15 + 60×10) / 100;
    const fresh = exportRows(a, [j2.jobId, j1.jobId], DEFAULT_WEIGHTS, DEFAULT_THRESHOLDS, true);
    expect(fresh.jobIds).toEqual([j2.jobId]);
    expect(exportRows(b, [j1.jobId], DEFAULT_WEIGHTS, DEFAULT_THRESHOLDS, true).rows).toEqual([]); // no analysis for Sam
  });
});

describe('result filters', () => {
  const now = new Date('2026-10-01T12:00:00Z');
  const row = (over: Partial<ScoredRow>): ScoredRow => ({
    jobId: 1,
    analysisId: 1,
    url: 'https://x.com/1',
    title: 'Backend Engineer',
    companyName: 'Acme',
    location: 'Remote',
    postingLocation: null,
    postedAt: '2026-09-29T00:00:00Z',
    postedAtSource: 'source',
    firstSeenAt: '2026-09-29T00:00:00Z',
    sourceKey: 'greenhouse',
    sourceLabel: 'Greenhouse',
    isClosed: false,
    closedReason: null,
    status: 'new',
    feedback: 0,
    feedbackNote: null,
    exportedAt: null,
    outcome: 'matched',
    hardFilterPass: true,
    hardFilterReasons: [],
    subScores: null,
    preScore: null,
    summary: 'Good fit',
    fields: fields(),
    modelId: 1,
    modelName: 'Sonnet',
    promptVersion: 1,
    currentResume: true,
    analyzedAt: '2026-09-30T00:00:00Z',
    total: 80,
    verdict: 'strong',
    ...over,
  });
  const rows = [
    row({ jobId: 1 }),
    row({ jobId: 2, total: 55, verdict: 'stretch', status: 'rejected', fields: fields({ work_mode: 'Onsite', tech_stack: ['Java'], salary_listed: false, salary_max: null, salary_min: null }) }),
    row({ jobId: 3, hardFilterPass: false, total: null, verdict: null }),
    row({ jobId: 4, isClosed: true }),
    row({ jobId: 5, postedAt: '2026-08-01T00:00:00Z', fields: fields({ salary_max: 60, salary_period: 'hour' }) }),
  ];
  const ids = (f: Partial<typeof DEFAULT_FILTERS>) => applyFilters(rows, { ...DEFAULT_FILTERS, ...f }, now).map((r) => r.jobId);

  it('hides hard-filter failures and closed jobs by default', () => {
    expect(ids({})).toEqual([1, 2, 5]);
    expect(ids({ showHardFiltered: true, hideClosed: false })).toEqual([1, 2, 3, 4, 5]);
  });

  it('score, verdict, status, date, facets, salary, search', () => {
    expect(ids({ minScore: 70 })).toEqual([1, 5]);
    expect(ids({ verdicts: ['stretch'] })).toEqual([2]);
    expect(ids({ hideReviewedRejected: true })).toEqual([1, 5]);
    expect(ids({ date: { preset: 'last7', from: null, to: null } })).toEqual([1, 2]);
    expect(ids({ facets: { work_mode: ['onsite'] } })).toEqual([2]);
    expect(ids({ facets: { tech_stack: ['Go'], work_mode: ['Remote'] } })).toEqual([1, 5]);
    expect(ids({ salaryListedOnly: true })).toEqual([1, 5]);
    expect(ids({ minSalary: 150000 })).toEqual([1]); // $60/h ≈ $124.8k/yr
    expect(ids({ search: 'acme' })).toEqual([1, 2, 5]);
    expect(yearlySalary(fields({ salary_max: 60, salary_period: 'hour' }))).toBe(124800);
    expect(facetCounts(rows, 'work_mode')).toEqual([
      { value: 'Remote', count: 4 },
      { value: 'Onsite', count: 1 },
    ]);
  });
});
