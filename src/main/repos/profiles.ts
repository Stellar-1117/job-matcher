import { bool, getDb, nowIso } from '../db';
import { ResumeParsedSchema, type ResumeParsed } from '@shared/llm-schemas';
import {
  DEFAULT_PREFERENCES,
  parsePreferences,
  type Preferences,
  type ProfileDetail,
  type ProfileSummary,
  type ResumeDetail,
  type ResumeSummary,
} from '@shared/profile';

function parseStructured(json: string | null): ResumeParsed | null {
  if (!json) return null;
  try {
    const r = ResumeParsedSchema.safeParse(JSON.parse(json));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

function toResumeSummary(r: any, activeId: number | null): ResumeSummary {
  return {
    id: r.id,
    profileId: r.profile_id,
    version: r.version,
    fileName: r.file_name,
    fileKind: r.file_kind,
    parseStatus: r.parse_status,
    isActive: r.id === activeId,
    edited: bool(r.structured_edited),
    createdAt: r.created_at,
  };
}

function touchProfile(id: number): void {
  getDb().prepare('UPDATE profiles SET updated_at = ? WHERE id = ?').run(nowIso(), id);
}

// ---- Profiles -------------------------------------------------------------------------------

export function listProfiles(): ProfileSummary[] {
  const rows = getDb()
    .prepare(
      `SELECT p.*, r.parse_status AS active_status, r.structured_json AS active_structured,
         (SELECT COUNT(*) FROM resumes x WHERE x.profile_id = p.id) AS resume_count
       FROM profiles p LEFT JOIN resumes r ON r.id = p.active_resume_id
       ORDER BY p.name COLLATE NOCASE`,
    )
    .all() as any[];
  return rows.map((p) => ({
    id: p.id,
    name: p.name,
    activeResumeId: p.active_resume_id,
    activeParseStatus: p.active_status ?? null,
    resumeCount: p.resume_count,
    headline: parseStructured(p.active_structured)?.headline ?? null,
    updatedAt: p.updated_at,
  }));
}

export function getProfile(id: number): ProfileDetail {
  const p = getDb().prepare('SELECT * FROM profiles WHERE id = ?').get(id) as any;
  if (!p) throw new Error('Profile not found');
  const resumes = getDb().prepare('SELECT * FROM resumes WHERE profile_id = ? ORDER BY version DESC').all(id) as any[];
  return {
    id: p.id,
    name: p.name,
    preferences: parsePreferences(p.preferences_json),
    activeResumeId: p.active_resume_id,
    resumes: resumes.map((r) => toResumeSummary(r, p.active_resume_id)),
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

export function createProfile(name: string): number {
  const res = getDb()
    .prepare('INSERT INTO profiles (name, preferences_json) VALUES (?, ?)')
    .run(name.trim(), JSON.stringify(DEFAULT_PREFERENCES));
  return Number(res.lastInsertRowid);
}

export function renameProfile(id: number, name: string): void {
  getDb().prepare('UPDATE profiles SET name = ?, updated_at = ? WHERE id = ?').run(name.trim(), nowIso(), id);
}

export function deleteProfile(id: number): void {
  getDb().prepare('DELETE FROM profiles WHERE id = ?').run(id);
}

export function savePreferences(id: number, prefs: Preferences): void {
  getDb().prepare('UPDATE profiles SET preferences_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(prefs), nowIso(), id);
}

// ---- Resumes --------------------------------------------------------------------------------

/** Every upload creates a new version, which becomes the profile's active resume. */
export function createResume(
  profileId: number,
  file: { fileName: string; kind: ResumeSummary['fileKind']; blob: Uint8Array | null; text: string },
): number {
  const db = getDb();
  return db.transaction(() => {
    if (!db.prepare('SELECT 1 FROM profiles WHERE id = ?').get(profileId)) throw new Error('Profile not found');
    const { next } = db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS next FROM resumes WHERE profile_id = ?').get(profileId) as { next: number };
    const res = db
      .prepare('INSERT INTO resumes (profile_id, version, file_name, file_kind, file_blob, text, parse_status) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(profileId, next, file.fileName, file.kind, file.blob ? Buffer.from(file.blob) : null, file.text, 'pending');
    const id = Number(res.lastInsertRowid);
    db.prepare('UPDATE profiles SET active_resume_id = ?, updated_at = ? WHERE id = ?').run(id, nowIso(), profileId);
    return id;
  })();
}

export function getResume(id: number): ResumeDetail {
  const r = getDb()
    .prepare(
      `SELECT r.*, p.active_resume_id, pr.version AS prompt_version
       FROM resumes r JOIN profiles p ON p.id = r.profile_id LEFT JOIN prompts pr ON pr.id = r.prompt_version_id
       WHERE r.id = ?`,
    )
    .get(id) as any;
  if (!r) throw new Error('Resume not found');
  return {
    ...toResumeSummary(r, r.active_resume_id),
    text: r.text,
    structured: parseStructured(r.structured_json),
    structuredParsed: parseStructured(r.structured_parsed_json),
    parseError: r.parse_error,
    modelName: r.model_name,
    promptVersion: r.prompt_version ?? null,
    parsedAt: r.parsed_at,
  };
}

export function getResumeFile(id: number): { fileName: string; blob: Buffer | null; text: string } {
  const r = getDb().prepare('SELECT file_name, file_blob, text FROM resumes WHERE id = ?').get(id) as any;
  if (!r) throw new Error('Resume not found');
  return { fileName: r.file_name, blob: r.file_blob, text: r.text };
}

export function setActiveResume(id: number): number {
  const r = getDb().prepare('SELECT profile_id FROM resumes WHERE id = ?').get(id) as { profile_id: number } | undefined;
  if (!r) throw new Error('Resume not found');
  getDb().prepare('UPDATE profiles SET active_resume_id = ?, updated_at = ? WHERE id = ?').run(id, nowIso(), r.profile_id);
  return r.profile_id;
}

/** Delete a resume version; if it was active, the newest remaining version becomes active. */
export function deleteResume(id: number): number {
  const db = getDb();
  return db.transaction(() => {
    const r = db.prepare('SELECT profile_id FROM resumes WHERE id = ?').get(id) as { profile_id: number } | undefined;
    if (!r) throw new Error('Resume not found');
    db.prepare('DELETE FROM resumes WHERE id = ?').run(id);
    const p = db.prepare('SELECT active_resume_id FROM profiles WHERE id = ?').get(r.profile_id) as { active_resume_id: number | null };
    if (p.active_resume_id === id) {
      const latest = db.prepare('SELECT id FROM resumes WHERE profile_id = ? ORDER BY version DESC LIMIT 1').get(r.profile_id) as { id: number } | undefined;
      db.prepare('UPDATE profiles SET active_resume_id = ? WHERE id = ?').run(latest?.id ?? null, r.profile_id);
    }
    touchProfile(r.profile_id);
    return r.profile_id;
  })();
}

export function setParseStatus(id: number, status: ResumeSummary['parseStatus'], error: string | null): void {
  getDb().prepare('UPDATE resumes SET parse_status = ?, parse_error = ? WHERE id = ?').run(status, error, id);
}

export function saveParseResult(id: number, data: ResumeParsed, promptVersionId: number, modelId: number, modelName: string): void {
  const json = JSON.stringify(data);
  getDb()
    .prepare(
      `UPDATE resumes SET structured_json = ?, structured_parsed_json = ?, structured_edited = 0, parse_status = 'done',
         parse_error = NULL, prompt_version_id = ?, model_id = ?, model_name = ?, parsed_at = ? WHERE id = ?`,
    )
    .run(json, json, promptVersionId, modelId, modelName, nowIso(), id);
}

/** Manual corrections to the parsed profile. */
export function saveStructured(id: number, data: ResumeParsed): void {
  getDb().prepare('UPDATE resumes SET structured_json = ?, structured_edited = 1 WHERE id = ?').run(JSON.stringify(data), id);
}

export function revertStructured(id: number): void {
  getDb().prepare('UPDATE resumes SET structured_json = structured_parsed_json, structured_edited = 0 WHERE id = ?').run(id);
}

/** Parses cut short by an app restart can't resume; mark them failed so the user can retry. */
export function failInterruptedParses(): number {
  return getDb()
    .prepare("UPDATE resumes SET parse_status = 'failed', parse_error = 'Interrupted when the app closed — click Re-parse.' WHERE parse_status = 'parsing'")
    .run().changes;
}
