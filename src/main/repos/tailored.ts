import { randomBytes } from 'node:crypto';
import { getDb, nowIso } from '../db';
import type { TailorState, TailoredChange, TailoredDetail, TailoredSummary } from '@shared/results';

/** Summary columns. Never add the blobs here: lists run over every tailored resume, and the DB is already large. */
const SUMMARY_SELECT = `SELECT t.job_id, t.profile_id, p.name AS profile_name, t.state, t.error, t.pdf_blob IS NOT NULL AS has_pdf,
    COALESCE(json_array_length(t.edits_json), 0) AS change_count, t.pages_original, t.pages_tailored,
    t.resume_id IS p.active_resume_id AS current_resume, t.updated_at
  FROM tailored_resumes t JOIN profiles p ON p.id = t.profile_id`;

function toSummary(r: any): TailoredSummary {
  return {
    jobId: r.job_id,
    profileId: r.profile_id,
    profileName: r.profile_name,
    state: r.state,
    error: r.error,
    hasPdf: r.has_pdf === 1,
    changeCount: r.change_count,
    pagesOriginal: r.pages_original,
    pagesTailored: r.pages_tailored,
    currentResume: r.current_resume === 1,
    updatedAt: r.updated_at,
  };
}

function parseJson<T>(json: string | null, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

/** Queue a job for tailoring. A row that already exists keeps its token, resume and files until the new ones are saved. */
export function enqueueTailored(jobId: number, profileId: number, resumeId: number, now = nowIso()): void {
  getDb()
    .prepare(
      `INSERT INTO tailored_resumes (job_id, profile_id, resume_id, state, token, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?, ?)
       ON CONFLICT(job_id, profile_id) DO UPDATE SET state = 'queued', error = NULL, updated_at = excluded.updated_at`,
    )
    .run(jobId, profileId, resumeId, randomBytes(18).toString('base64url'), now, now);
}

export function setTailoredRunning(jobId: number, profileId: number, now = nowIso()): void {
  getDb().prepare("UPDATE tailored_resumes SET state = 'running', updated_at = ? WHERE job_id = ? AND profile_id = ?").run(now, jobId, profileId);
}

export function failTailored(jobId: number, profileId: number, error: string, now = nowIso()): void {
  getDb().prepare("UPDATE tailored_resumes SET state = 'failed', error = ?, updated_at = ? WHERE job_id = ? AND profile_id = ?").run(error, now, jobId, profileId);
}

export interface TailoredResult {
  resumeId: number;
  changes: TailoredChange[];
  addedSkills: string[];
  droppedEdits: number;
  docx: Uint8Array;
  pdf: Uint8Array;
  pagesOriginal: number;
  pagesTailored: number;
  promptVersionId: number;
  modelId: number;
  modelName: string;
  costUsd: number;
}

export function saveTailored(jobId: number, profileId: number, r: TailoredResult, now = nowIso()): void {
  getDb()
    .prepare(
      `UPDATE tailored_resumes SET state = 'ready', error = NULL, resume_id = @resumeId, edits_json = @edits, added_skills_json = @added,
         dropped_edits = @dropped, docx_blob = @docx, pdf_blob = @pdf, pages_original = @pagesOriginal, pages_tailored = @pagesTailored,
         prompt_version_id = @promptVersionId, model_id = @modelId, model_name = @modelName, cost_usd = @costUsd, updated_at = @now
       WHERE job_id = @jobId AND profile_id = @profileId`,
    )
    .run({
      jobId,
      profileId,
      resumeId: r.resumeId,
      edits: JSON.stringify(r.changes),
      added: JSON.stringify(r.addedSkills),
      dropped: r.droppedEdits,
      docx: Buffer.from(r.docx),
      pdf: Buffer.from(r.pdf),
      pagesOriginal: r.pagesOriginal,
      pagesTailored: r.pagesTailored,
      promptVersionId: r.promptVersionId,
      modelId: r.modelId,
      modelName: r.modelName,
      costUsd: r.costUsd,
      now,
    });
}

/** Rows left queued or running when the app closed can't finish: nothing is working on them any more. */
export function failInterruptedTailors(): number {
  return getDb()
    .prepare("UPDATE tailored_resumes SET state = 'failed', error = 'Interrupted when the app closed — click Retry.' WHERE state IN ('queued', 'running')")
    .run().changes;
}

export function getTailoredSummary(jobId: number, profileId: number): TailoredSummary | null {
  const r = getDb().prepare(`${SUMMARY_SELECT} WHERE t.job_id = ? AND t.profile_id = ?`).get(jobId, profileId);
  return r ? toSummary(r) : null;
}

/** For the Results rows of one profile: job id → tailored resumes for that job across all profiles. */
export function listTailoredForProfile(profileId: number): Map<number, TailoredSummary[]> {
  const rows = getDb()
    .prepare(`${SUMMARY_SELECT} WHERE t.job_id IN (SELECT job_id FROM analyses WHERE profile_id = ?) ORDER BY p.name`)
    .all(profileId);
  const out = new Map<number, TailoredSummary[]>();
  for (const r of rows) {
    const s = toSummary(r);
    const list = out.get(s.jobId);
    if (list) list.push(s);
    else out.set(s.jobId, [s]);
  }
  return out;
}

/** State of this profile's tailored resumes, by job. */
export function tailoredStates(profileId: number): Map<number, TailorState> {
  const rows = getDb().prepare('SELECT job_id, state FROM tailored_resumes WHERE profile_id = ?').all(profileId) as { job_id: number; state: TailorState }[];
  return new Map(rows.map((r) => [r.job_id, r.state]));
}

/** The page count already measured for this resume version, if any tailored resume has been made from it. */
export function knownOriginalPages(resumeId: number): number | null {
  const r = getDb().prepare('SELECT pages_original FROM tailored_resumes WHERE resume_id = ? AND pages_original IS NOT NULL LIMIT 1').get(resumeId) as { pages_original: number } | undefined;
  return r?.pages_original ?? null;
}

/** Job id → link token, for this profile's tailored resumes that have a PDF. */
export function readyTokens(profileId: number): Map<number, string> {
  const rows = getDb().prepare('SELECT job_id, token FROM tailored_resumes WHERE profile_id = ? AND pdf_blob IS NOT NULL').all(profileId) as { job_id: number; token: string }[];
  return new Map(rows.map((r) => [r.job_id, r.token]));
}

export function getTailoredToken(jobId: number, profileId: number): string | null {
  const r = getDb().prepare('SELECT token FROM tailored_resumes WHERE job_id = ? AND profile_id = ? AND pdf_blob IS NOT NULL').get(jobId, profileId) as { token: string } | undefined;
  return r?.token ?? null;
}

export function getTailoredPdf(jobId: number, profileId: number): { pdf: Buffer; profileName: string } | null {
  const r = getDb()
    .prepare('SELECT t.pdf_blob, p.name FROM tailored_resumes t JOIN profiles p ON p.id = t.profile_id WHERE t.job_id = ? AND t.profile_id = ? AND t.pdf_blob IS NOT NULL')
    .get(jobId, profileId) as { pdf_blob: Buffer; name: string } | undefined;
  return r ? { pdf: r.pdf_blob, profileName: r.name } : null;
}

export function getPdfByToken(token: string): { pdf: Buffer; profileName: string } | null {
  const r = getDb()
    .prepare('SELECT t.pdf_blob, p.name FROM tailored_resumes t JOIN profiles p ON p.id = t.profile_id WHERE t.token = ? AND t.pdf_blob IS NOT NULL')
    .get(token) as { pdf_blob: Buffer; name: string } | undefined;
  return r ? { pdf: r.pdf_blob, profileName: r.name } : null;
}

export function getTailoredDetail(jobId: number, profileId: number): TailoredDetail | null {
  const db = getDb();
  const summary = getTailoredSummary(jobId, profileId);
  if (!summary) return null;
  const r = db
    .prepare(
      `SELECT t.edits_json, t.added_skills_json, t.dropped_edits, t.model_name, t.cost_usd, pr.version AS prompt_version, rv.version AS resume_version
       FROM tailored_resumes t
       LEFT JOIN prompts pr ON pr.id = t.prompt_version_id
       LEFT JOIN resumes rv ON rv.id = t.resume_id
       WHERE t.job_id = ? AND t.profile_id = ?`,
    )
    .get(jobId, profileId) as any;
  return {
    ...summary,
    changes: parseJson<TailoredChange[]>(r.edits_json, []),
    addedSkills: parseJson<string[]>(r.added_skills_json, []),
    droppedEdits: r.dropped_edits,
    modelName: r.model_name,
    promptVersion: r.prompt_version ?? null,
    resumeVersion: r.resume_version ?? null,
    costUsd: r.cost_usd,
  };
}
