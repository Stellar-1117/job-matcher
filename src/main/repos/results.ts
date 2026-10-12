import { getDb, nowIso } from '../db';
import { StoredJobExtractionSchema } from '@shared/llm-schemas';
import { sourceLabel } from '@shared/jobs';
import type { Thresholds, Weights } from '@shared/scoring';
import {
  exportWorkType,
  scoreRow,
  stripWorkMode,
  subScoresFromJson,
  type ExportRow,
  type JobStatus,
  type ResultDetail,
  type ResultFields,
  type ResultRow,
  type ResultsList,
} from '@shared/results';
import { getModel } from './models';
import { getRoute } from './routes';
import { getActivePrompt } from './prompts';

function parseFields(json: string | null): ResultFields | null {
  if (!json) return null;
  try {
    const r = StoredJobExtractionSchema.safeParse(JSON.parse(json));
    if (!r.success) return null;
    const { responsibilities: _r, job_title: _t, company_name: _c, location: _l, ...fields } = r.data;
    return fields;
  } catch {
    return null;
  }
}

/** The posting's own location from an extraction's JSON (null for older extractions that didn't record it). */
function postingLocation(json: string | null): string | null {
  if (!json) return null;
  try {
    const loc = (JSON.parse(json) as { location?: unknown }).location;
    return typeof loc === 'string' && loc.trim() ? loc.trim() : null;
  } catch {
    return null;
  }
}

function parseJson<T>(json: string | null, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

/**
 * Results for one profile (§12): per job, the latest analysis — preferring the profile's current
 * resume version. Totals/verdicts are not stored; the UI computes them from the sub-scores.
 */
export function listResults(profileId: number): ResultsList {
  const db = getDb();
  const profile = db.prepare('SELECT active_resume_id FROM profiles WHERE id = ?').get(profileId) as { active_resume_id: number | null } | undefined;
  if (!profile) throw new Error('Profile not found');
  const activeResume = profile.active_resume_id ?? -1;
  const rows = db
    .prepare(
      `SELECT a.id, a.job_id, a.resume_id, a.model_id, a.model_name, a.outcome, a.hard_filter_pass, a.hard_filter_reasons_json,
         a.sub_scores_json, a.pre_score, a.summary, a.updated_at,
         j.canonical_url, j.title, j.company_name, j.location_raw, j.posted_at, j.posted_at_source, j.first_seen_at, j.source_key,
         j.is_closed, j.closed_reason, s.status, s.feedback, s.feedback_note, s.exported_at, pr.version AS prompt_version, e.fields_json,
         je.fields_json AS job_fields_json
       FROM analyses a
       JOIN jobs j ON j.id = a.job_id
       LEFT JOIN job_profile_status s ON s.job_id = a.job_id AND s.profile_id = a.profile_id
       LEFT JOIN prompts pr ON pr.id = a.prompt_version_id
       LEFT JOIN job_extractions e ON e.id = COALESCE(a.extraction_id, j.extraction_id)
       LEFT JOIN job_extractions je ON je.id = j.extraction_id
       WHERE a.profile_id = @p AND a.id = (
         SELECT a2.id FROM analyses a2 WHERE a2.job_id = a.job_id AND a2.profile_id = @p
         ORDER BY (a2.resume_id = @r) DESC, a2.updated_at DESC, a2.id DESC LIMIT 1)`,
    )
    .all({ p: profileId, r: activeResume }) as any[];

  const route = getRoute('matching');
  const currentModelId = route?.model_id ?? route?.fallback_model_id ?? null;
  return {
    profileId,
    currentModelId,
    currentModelName: currentModelId != null ? getModel(currentModelId)?.display_name ?? null : null,
    currentPromptVersion: getActivePrompt('matching')?.version ?? null,
    rows: rows.map(
      (r): ResultRow => ({
        jobId: r.job_id,
        analysisId: r.id,
        url: r.canonical_url,
        title: r.title,
        companyName: r.company_name,
        location: r.location_raw,
        postingLocation: postingLocation(r.job_fields_json) ?? postingLocation(r.fields_json),
        postedAt: r.posted_at,
        postedAtSource: r.posted_at_source,
        firstSeenAt: r.first_seen_at,
        sourceKey: r.source_key,
        sourceLabel: sourceLabel(r.source_key),
        isClosed: r.is_closed === 1,
        closedReason: r.closed_reason,
        status: (r.status ?? 'new') as JobStatus,
        feedback: (r.feedback ?? 0) as -1 | 0 | 1,
        feedbackNote: r.feedback_note ?? null,
        exportedAt: r.exported_at ?? null,
        outcome: r.outcome,
        hardFilterPass: r.hard_filter_pass === 1,
        hardFilterReasons: parseJson<string[]>(r.hard_filter_reasons_json, []),
        subScores: r.outcome === 'matched' ? subScoresFromJson(r.sub_scores_json) : null,
        preScore: r.pre_score,
        summary: r.summary,
        fields: parseFields(r.fields_json),
        modelId: r.model_id,
        modelName: r.model_name,
        promptVersion: r.prompt_version ?? null,
        currentResume: r.resume_id === activeResume,
        analyzedAt: r.updated_at,
      }),
    ),
  };
}

export function getResultDetail(analysisId: number): ResultDetail {
  const r = getDb()
    .prepare(
      `SELECT a.*, pr.version AS prompt_version, rv.version AS resume_version, e.fields_json, e.model_name AS extraction_model
       FROM analyses a
       LEFT JOIN prompts pr ON pr.id = a.prompt_version_id
       LEFT JOIN resumes rv ON rv.id = a.resume_id
       LEFT JOIN jobs j ON j.id = a.job_id
       LEFT JOIN job_extractions e ON e.id = COALESCE(a.extraction_id, j.extraction_id)
       WHERE a.id = ?`,
    )
    .get(analysisId) as any;
  if (!r) throw new Error('Analysis not found');
  const fields = r.fields_json ? StoredJobExtractionSchema.safeParse(parseJson(r.fields_json, null)) : null;
  return {
    analysisId: r.id,
    subScores: r.outcome === 'matched' ? parseJson(r.sub_scores_json, null) : null,
    strengths: r.outcome === 'matched' ? parseJson(r.strengths_json, []) : [],
    gaps: r.outcome === 'matched' ? parseJson(r.gaps_json, []) : [],
    summary: r.outcome === 'matched' ? r.summary : null,
    preScore: r.pre_score,
    preScoreReason: r.pre_score_reason,
    hardFilters: parseJson(r.hard_filter_results_json, []),
    fields: fields?.success ? fields.data : null,
    extractionModel: r.extraction_model ?? null,
    modelName: r.model_name,
    promptVersion: r.prompt_version ?? null,
    resumeVersion: r.resume_version ?? null,
    analyzedAt: r.updated_at,
    costUsd: r.cost_usd,
  };
}

// ---- Status, feedback, export ---------------------------------------------------------------

export function getStatus(profileId: number, jobId: number): JobStatus {
  const r = getDb().prepare('SELECT status FROM job_profile_status WHERE job_id = ? AND profile_id = ?').get(jobId, profileId) as { status: JobStatus } | undefined;
  return r?.status ?? 'new';
}

/** Set the status of jobs for ONE profile; other profiles' statuses are untouched. */
export function setStatuses(profileId: number, jobIds: number[], status: JobStatus, now = nowIso()): number {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO job_profile_status (job_id, profile_id, status, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(job_id, profile_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
  );
  let n = 0;
  db.transaction(() => {
    for (const id of jobIds) n += stmt.run(id, profileId, status, now).changes;
  })();
  return n;
}

/** Opening a row: new → reviewed (only from "new"). Returns the resulting status. */
export function markOpened(profileId: number, jobId: number): JobStatus {
  const cur = getStatus(profileId, jobId);
  if (cur !== 'new') return cur;
  setStatuses(profileId, [jobId], 'reviewed');
  return 'reviewed';
}

export function setFeedback(profileId: number, jobId: number, feedback: -1 | 0 | 1, note: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO job_profile_status (job_id, profile_id, feedback, feedback_note, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(job_id, profile_id) DO UPDATE SET feedback = excluded.feedback, feedback_note = excluded.feedback_note, updated_at = excluded.updated_at`,
    )
    .run(jobId, profileId, feedback, note?.trim() || null, nowIso());
}

export function markExported(profileId: number, jobIds: number[], now = nowIso()): void {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO job_profile_status (job_id, profile_id, status, exported_at, updated_at) VALUES (?, ?, 'exported', ?, ?)
     ON CONFLICT(job_id, profile_id) DO UPDATE SET status = 'exported', exported_at = excluded.exported_at, updated_at = excluded.updated_at`,
  );
  db.transaction(() => {
    for (const id of jobIds) stmt.run(id, profileId, now, now);
  })();
}

/** Rows to export, in the order given (the table's order), scored with the current weights. */
export function exportRows(profileId: number, jobIds: number[], weights: Weights, thresholds: Thresholds, skipExported: boolean): { rows: ExportRow[]; jobIds: number[] } {
  const byJob = new Map(listResults(profileId).rows.map((r) => [r.jobId, r]));
  const rows: ExportRow[] = [];
  const ids: number[] = [];
  for (const id of jobIds) {
    const r = byJob.get(id);
    if (!r || (skipExported && r.exportedAt)) continue;
    const s = scoreRow(r, weights, thresholds);
    rows.push({
      url: r.url,
      title: r.title,
      company: r.companyName,
      workType: exportWorkType(r.fields?.work_mode, r.location),
      location: r.postingLocation ?? stripWorkMode(r.location),
      score: s.total,
      verdict: s.verdict,
      summary: r.summary,
    });
    ids.push(id);
  }
  return { rows, jobIds: ids };
}
