import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderRequest, ProviderResponse } from '../src/main/llm/types';
import { ResumeTailorSchema } from '../src/shared/llm-schemas';
import { makeDocxFromBody } from './fixtures';

// ---- Mocked LLM providers ---------------------------------------------------------------------

const prompts: string[] = [];
let answer: (text: string) => string = () => JSON.stringify({ edits: [{ id: 2, text: 'Built the **ledger** in Go for payments.' }, { id: 4, text: 'Go, Kafka, SQL, PostgreSQL, Redis, Docker, Terraform' }], added_skills: ['Kafka', 'kafka ', 'Go', 'Cassandra'] });

function scripted() {
  return {
    async complete(req: ProviderRequest): Promise<ProviderResponse> {
      if (req.schema !== ResumeTailorSchema) throw new Error('unexpected request');
      const text = req.parts.map((p) => p.text).join('');
      prompts.push(text);
      return { text: answer(text), usage: { uncachedInput: 1000, cacheWrite: 0, cachedInput: 0, output: 200 }, stopReason: 'stop' };
    },
    async test() {
      return 'ok';
    },
  };
}

vi.mock('../src/main/llm/anthropic', () => ({ anthropicAdapter: scripted() }));
vi.mock('../src/main/llm/openai-compat', () => ({ makeOpenAICompatAdapter: () => scripted() }));

const { setupTestDb } = await import('./helpers');
const { getDb } = await import('../src/main/db');
const { setKey } = await import('../src/main/repos/keys');
const { upsertCollectedJob } = await import('../src/main/repos/jobs');
const { createProfile, createResume, saveParseResult } = await import('../src/main/repos/profiles');
const { upsertAnalysis } = await import('../src/main/repos/analysis');
const { updateSettings } = await import('../src/main/repos/settings');
const { exportRows, getStatus, listResults, markExported, setStatuses } = await import('../src/main/repos/results');
const { failInterruptedTailors, getPdfByToken, getTailoredDetail, getTailoredPdf, getTailoredSummary, getTailoredToken } = await import('../src/main/repos/tailored');
const { estimateTailorRun, regenerateTailored, startTailor } = await import('../src/main/runs/tailor');
const { BudgetExceededError } = await import('../src/main/runs/analyze');
const { appEvents } = await import('../src/main/events');
const { DEFAULT_THRESHOLDS, DEFAULT_WEIGHTS } = await import('../src/shared/scoring');

const SUB = { score: 80, reason: 'ok' };
const MATCH = { sub_scores: { skills: SUB, domain_fit: SUB, project_similarity: SUB, experience_fit: SUB, preferences_fit: SUB }, strengths: [], gaps: [], summary: 'Fit' };
const PARSED = {
  name: 'Alex',
  headline: null,
  total_years_experience: 5,
  skills: [],
  roles: [{ title: 'Engineer', company: 'Acme', start: '2020', end: 'present', summary: null }],
  projects: [],
  domains: [],
  education: [],
  languages: [],
};

const para = (t: string) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
const bullet = (t: string) => `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
const RESUME_BODY = para('Alex') + para('EXPERIENCE') + bullet('Built the ledger service in Go.') + para('SKILLS') + para('Go, SQL, PostgreSQL, Redis, Docker, Terraform');

// Fake Word: the "PDF" is the DOCX's bytes, so tests can see which file got exported.
const wordCalls: Uint8Array[] = [];
let wordPages = 2;
let wordError: Error | null = null;
const fakeWord = async (docx: Uint8Array) => {
  wordCalls.push(docx);
  if (wordError) throw wordError;
  return { pdf: Buffer.from(docx), pages: wordPages };
};
const deps = { toPdf: fakeWord, concurrency: 2 };

let profileId: number;
let n = 0;

async function addProfile(name: string, kind: 'docx' | 'pdf' | 'pasted' = 'docx'): Promise<number> {
  const id = createProfile(name);
  const blob = kind === 'pasted' ? null : kind === 'docx' ? await makeDocxFromBody(RESUME_BODY) : new TextEncoder().encode('%PDF-1.4');
  const rid = createResume(id, { fileName: `cv.${kind}`, kind, blob, text: 'Alex built the ledger' });
  saveParseResult(rid, PARSED, 1, 1, 'test');
  return id;
}

function addJob(profile: number, outcome: 'matched' | 'hard_filter' = 'matched'): number {
  n++;
  const jobId = upsertCollectedJob(
    { url: `https://job-boards.greenhouse.io/beta/jobs/${n}`, externalId: String(n), title: `Job ${n}`, companyName: 'Beta', location: 'NYC', postedAt: new Date().toISOString(), postedAtSource: 'source', descriptionText: 'Build payment APIs in Go' },
    { sourceKey: 'greenhouse', companyId: null, now: new Date().toISOString(), insertIfNew: true },
  ).jobId!;
  linkAnalysis(jobId, profile, outcome);
  return jobId;
}

function linkAnalysis(jobId: number, profile: number, outcome: 'matched' | 'hard_filter' = 'matched'): void {
  const resumeId = (getDb().prepare('SELECT active_resume_id AS r FROM profiles WHERE id = ?').get(profile) as { r: number }).r;
  const hard = outcome === 'matched' ? { pass: true, reasons: [], results: [] } : { pass: false, reasons: ['Location'], results: [] };
  upsertAnalysis({ jobId, profileId: profile, resumeId, promptVersionId: 1, modelId: 1 }, { outcome, extractionId: null, hard, runId: null, match: outcome === 'matched' ? MATCH : undefined });
}

beforeEach(async () => {
  setupTestDb();
  prompts.length = 0;
  wordCalls.length = 0;
  wordPages = 2;
  wordError = null;
  answer = () => JSON.stringify({ edits: [{ id: 2, text: 'Built the **ledger** in Go for payments.' }, { id: 4, text: 'Go, Kafka, SQL, PostgreSQL, Redis, Docker, Terraform' }], added_skills: ['Kafka', 'kafka ', 'Go', 'Cassandra'] });
  setKey({ provider: 'anthropic', key: 'k' });
  setKey({ provider: 'deepseek', key: 'k' });
  profileId = await addProfile('Alex Main');
});

async function tailorOk(jobIds: number[], profile = profileId) {
  const r = await startTailor({ profileId: profile, jobIds, budgetOverride: false }, deps);
  await r.done;
  return r;
}

describe('tailoring', () => {
  it('rewrites the resume, keeps the review data, and sets the status', async () => {
    const job = addJob(profileId);
    expect((await tailorOk([job])).started).toBe(1);

    expect(prompts[0]).toContain('[2, max 35 chars] Built the ledger service in Go.');
    expect(prompts[0]).toContain('[locked] Alex');
    expect(prompts[0].indexOf('<resume>')).toBeLessThan(prompts[0].indexOf('<job>'));

    expect(getStatus(profileId, job)).toBe('tailored');
    const d = getTailoredDetail(job, profileId)!;
    expect(d).toMatchObject({ state: 'ready', hasPdf: true, changeCount: 2, droppedEdits: 0, pagesOriginal: 2, pagesTailored: 2, currentResume: true, addedSkills: ['Kafka'] });
    expect(d.changes[0]).toEqual({ id: 2, before: 'Built the ledger service in Go.', after: 'Built the **ledger** in Go for payments.' });
    expect(d.costUsd).toBeGreaterThan(0);
    expect(getTailoredPdf(job, profileId)!.profileName).toBe('Alex Main');
    const usage = getDb().prepare("SELECT COUNT(*) AS c FROM usage_log WHERE task = 'resume_tailor'").get() as { c: number };
    expect(usage.c).toBe(1);
  });

  it('applied and rejected stay; a later export still sets exported', async () => {
    const [a, b, c] = [addJob(profileId), addJob(profileId), addJob(profileId)];
    setStatuses(profileId, [a], 'applied');
    setStatuses(profileId, [b], 'rejected');
    await tailorOk([a, b, c]);
    expect(getStatus(profileId, a)).toBe('applied');
    expect(getStatus(profileId, b)).toBe('rejected');
    expect(getStatus(profileId, c)).toBe('tailored');
    markExported(profileId, [c]);
    expect(getStatus(profileId, c)).toBe('exported');
    expect(getTailoredSummary(c, profileId)?.state).toBe('ready');
  });

  it('skips jobs already tailored and jobs without a full match, and says how many', async () => {
    const [done, fresh, filtered] = [addJob(profileId), addJob(profileId), addJob(profileId, 'hard_filter')];
    await tailorOk([done]);
    const est = await estimateTailorRun(profileId, [done, fresh, filtered]);
    expect(est).toMatchObject({ resumeProblem: null, toTailor: 1, alreadyTailored: 1, notMatched: 1, profileName: 'Alex Main' });
    expect(est.task.task).toBe('resume_tailor');
    prompts.length = 0;
    expect((await tailorOk([done, fresh, filtered])).started).toBe(1);
    expect(prompts).toHaveLength(1);
  });

  it('regenerating replaces the file and keeps the link', async () => {
    const job = addJob(profileId);
    await tailorOk([job]);
    const token = getTailoredToken(job, profileId)!;
    const firstPdf = getPdfByToken(token)!.pdf;
    answer = () => JSON.stringify({ edits: [{ id: 2, text: 'Designed the ledger service in Go.' }], added_skills: [] });
    await (await regenerateTailored(profileId, job, deps)).done;
    expect(getTailoredToken(job, profileId)).toBe(token);
    expect(getPdfByToken(token)!.pdf.equals(firstPdf)).toBe(false);
    expect(getTailoredDetail(job, profileId)).toMatchObject({ state: 'ready', addedSkills: [], changes: [{ after: 'Designed the ledger service in Go.' }] });
  });

  it('keeps the old file when regenerating fails', async () => {
    const job = addJob(profileId);
    await tailorOk([job]);
    const token = getTailoredToken(job, profileId)!;
    wordError = new Error('Word broke');
    await (await regenerateTailored(profileId, job, deps)).done;
    expect(getTailoredSummary(job, profileId)).toMatchObject({ state: 'failed', error: 'Word broke', hasPdf: true });
    expect(getPdfByToken(token)).not.toBeNull();
  });

  it('refuses PDF and pasted resumes with a clear message', async () => {
    const pdf = await addProfile('PDF Person', 'pdf');
    const pasted = await addProfile('Pasted Person', 'pasted');
    const job = addJob(pdf);
    expect((await estimateTailorRun(pdf, [job])).resumeProblem).toMatch(/PDF Person's active resume is a PDF file.*DOCX/);
    await expect(startTailor({ profileId: pdf, jobIds: [job], budgetOverride: false }, deps)).rejects.toThrow(/upload the resume as a DOCX/);
    await expect(startTailor({ profileId: pasted, jobIds: [job], budgetOverride: false }, deps)).rejects.toThrow(/pasted text/);
    expect(getTailoredSummary(job, pdf)).toBeNull();
    expect(prompts).toHaveLength(0);
  });

  it('a failure stays on its own row, and Retry can redo it', async () => {
    const bad = addJob(profileId);
    const badTitle = `Job ${n}`;
    const good = addJob(profileId);
    answer = (text) => (text.includes(`Title: ${badTitle}
`) ? 'not json at all' : JSON.stringify({ edits: [], added_skills: [] }));
    await tailorOk([bad, good]);
    expect(getTailoredSummary(bad, profileId)?.state).toBe('failed');
    expect(getTailoredSummary(good, profileId)?.state).toBe('ready');
    expect(getStatus(profileId, bad)).toBe('new');

    answer = () => JSON.stringify({ edits: [], added_skills: [] });
    expect((await tailorOk([bad])).started).toBe(1); // failed rows aren't "already tailored"
    expect(getTailoredSummary(bad, profileId)?.state).toBe('ready');
  });

  it('only reports added skills that are in the applied text and new to the resume', async () => {
    const job = addJob(profileId);
    // Kafka is in an edit that gets refused, Cassandra in no edit at all, and Go is already on the resume.
    answer = () => JSON.stringify({ edits: [{ id: 0, text: 'Kafka' }, { id: 2, text: 'Built the ledger service in Go.' }, { id: 4, text: 'Go, Redis, SQL, PostgreSQL, Docker, Terraform, Helm' }], added_skills: ['Kafka', 'Cassandra', 'Go', 'Helm'] });
    await tailorOk([job]);
    expect(getTailoredDetail(job, profileId)?.addedSkills).toEqual(['Helm']);
  });

  it('drops edits to locked text and counts them', async () => {
    const job = addJob(profileId);
    answer = () => JSON.stringify({ edits: [{ id: 0, text: 'Someone Else' }, { id: 4, text: 'Go, Kafka, SQL, PostgreSQL, Redis, Docker, Terraform' }], added_skills: ['Kafka'] });
    await tailorOk([job]);
    expect(getTailoredDetail(job, profileId)).toMatchObject({ droppedEdits: 1, changes: [{ id: 4 }] });
  });

  it('records page counts and a changed page count', async () => {
    const job = addJob(profileId);
    const pages = [2, 3];
    await (await startTailor({ profileId, jobIds: [job], budgetOverride: false }, { toPdf: async (d) => ({ pdf: Buffer.from(d), pages: pages.shift()! }) })).done;
    expect(getTailoredSummary(job, profileId)).toMatchObject({ pagesOriginal: 2, pagesTailored: 3 });
  });

  it('asks before going over budget', async () => {
    const job = addJob(profileId);
    updateSettings({ monthlyBudgetUsd: 0.000001 });
    await expect(startTailor({ profileId, jobIds: [job], budgetOverride: false }, deps)).rejects.toThrow(BudgetExceededError);
    expect(getTailoredSummary(job, profileId)).toBeNull();
    await (await startTailor({ profileId, jobIds: [job], budgetOverride: true }, deps)).done;
    expect(getTailoredSummary(job, profileId)?.state).toBe('ready');
  });

  it('marks unfinished rows as interrupted on startup', async () => {
    const job = addJob(profileId);
    await tailorOk([job]);
    getDb().prepare("UPDATE tailored_resumes SET state = 'running'").run();
    expect(failInterruptedTailors()).toBe(1);
    expect(getTailoredSummary(job, profileId)).toMatchObject({ state: 'failed', hasPdf: true });
    expect(getTailoredSummary(job, profileId)?.error).toMatch(/Interrupted/);
  });

  it('pushes progress events with the new status', async () => {
    const seen: string[] = [];
    const off = (p: { summary: { state: string }; status: string | null }) => seen.push(`${p.summary.state}:${p.status}`);
    appEvents.on('tailor:progress', off);
    await tailorOk([addJob(profileId)]);
    appEvents.off('tailor:progress', off);
    expect(seen).toEqual(['queued:null', 'running:null', 'ready:tailored']);
  });
});

describe('results and export', () => {
  it('lists tailored resumes across profiles without their files, and exports each profile its own link', async () => {
    const second = await addProfile('Alex Second');
    const job = addJob(profileId);
    linkAnalysis(job, second);
    await tailorOk([job]);
    await tailorOk([job], second);

    const row = listResults(profileId).rows[0];
    expect(row.tailored.map((t) => t.profileName)).toEqual(['Alex Main', 'Alex Second']);
    expect(JSON.stringify(row.tailored)).not.toContain('blob');

    const links = [profileId, second].map((p) => exportRows(p, [job], DEFAULT_WEIGHTS, DEFAULT_THRESHOLDS, false).rows[0].resumeLink);
    expect(links[0]).toContain(`/r/${getTailoredToken(job, profileId)}`);
    expect(links[1]).toContain(`/r/${getTailoredToken(job, second)}`);
    expect(links[0]).not.toBe(links[1]);
  });

  it('has no link for a job without a tailored PDF, and uses the configured host', async () => {
    const [plain, tailored] = [addJob(profileId), addJob(profileId)];
    await tailorOk([tailored]);
    updateSettings({ lan: { port: 5000, host: 'resumes.local' } });
    const rows = exportRows(profileId, [plain, tailored], DEFAULT_WEIGHTS, DEFAULT_THRESHOLDS, false).rows;
    expect(rows[0].resumeLink).toBeNull();
    expect(rows[1].resumeLink).toBe(`http://resumes.local:5000/r/${getTailoredToken(tailored, profileId)}`);
  });

  it('deleting a profile or job removes its tailored resumes', async () => {
    const job = addJob(profileId);
    await tailorOk([job]);
    getDb().prepare('DELETE FROM profiles WHERE id = ?').run(profileId);
    expect(getDb().prepare('SELECT COUNT(*) AS c FROM tailored_resumes').get()).toEqual({ c: 0 });
  });
});
