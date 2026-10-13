import { bool, getDb, nowIso } from '../db';
import { sourceLabel, type AddLinksResult, type JobListItem, type JobProfileAnalysis } from '@shared/jobs';
import { computeTotal, computeVerdict } from '@shared/scoring';
import { subScoresFromJson } from '@shared/results';
import { getSettings } from './settings';
import { ATS_SOURCE_KEYS } from '@shared/collect';
import { normalizeUrl, splitLinkInput } from '../sources/url';
import { hintsFromUrl } from '../sources/detect';
import { dedupeKey, dedupePrefix } from '../sources/dedupe';
import type { PostedAtSource, RawJob } from '../sources/types';

/**
 * Per job, the profiles it was analyzed for: the latest analysis per job × profile, preferring the
 * profile's current resume (as the Results screen does), scored with the current weights.
 */
function analysesByJob(jobId: number | null): Map<number, JobProfileAnalysis[]> {
  const { weights, thresholds } = getSettings();
  const rows = getDb()
    .prepare(
      `SELECT job_id, profile_id, name, outcome, hard_filter_pass, sub_scores_json FROM (
         SELECT a.job_id, a.profile_id, p.name, a.outcome, a.hard_filter_pass, a.sub_scores_json,
           ROW_NUMBER() OVER (PARTITION BY a.job_id, a.profile_id ORDER BY (a.resume_id = p.active_resume_id) DESC, a.updated_at DESC, a.id DESC) AS rn
         FROM analyses a JOIN profiles p ON p.id = a.profile_id
         WHERE @job IS NULL OR a.job_id = @job)
       WHERE rn = 1
       ORDER BY name COLLATE NOCASE`,
    )
    .all({ job: jobId }) as { job_id: number; profile_id: number; name: string; outcome: string; hard_filter_pass: number; sub_scores_json: string | null }[];
  const map = new Map<number, JobProfileAnalysis[]>();
  for (const r of rows) {
    const sub = r.outcome === 'matched' && r.hard_filter_pass === 1 ? subScoresFromJson(r.sub_scores_json) : null;
    const score = sub ? computeTotal(sub, weights) : null;
    const list = map.get(r.job_id) ?? [];
    list.push({
      profileId: r.profile_id,
      profileName: r.name,
      status: sub ? 'scored' : r.hard_filter_pass === 0 ? 'filtered' : 'skipped',
      score,
      verdict: score != null ? computeVerdict(score, thresholds) : null,
    });
    map.set(r.job_id, list);
  }
  return map;
}

function toItem(r: any, extra: string[], analyses: JobProfileAnalysis[]): JobListItem {
  return {
    id: r.id,
    url: r.canonical_url,
    sourceKey: r.source_key,
    sourceLabel: sourceLabel(r.source_key),
    companyId: r.company_id ?? null,
    companyName: r.company_name,
    title: r.title,
    location: r.location_raw,
    postedAt: r.posted_at,
    postedAtSource: r.posted_at_source,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at ?? null,
    fetchStatus: r.fetch_status,
    hasDescription: !!r.has_description,
    isClosed: bool(r.is_closed),
    closedReason: r.closed_reason ?? null,
    fetchError: r.fetch_error ?? null,
    extraUrls: extra,
    analyses,
  };
}

const LIST_COLUMNS = `id, canonical_url, source_key, company_id, company_name, title, location_raw, posted_at, posted_at_source,
  first_seen_at, last_seen_at, fetch_status, is_closed, closed_reason, fetch_error, (description_text IS NOT NULL AND description_text <> '') AS has_description`;

function extraUrlsByJob(): Map<number, string[]> {
  const rows = getDb().prepare('SELECT job_id, url FROM job_urls ORDER BY id').all() as { job_id: number; url: string }[];
  const map = new Map<number, string[]>();
  for (const r of rows) {
    const list = map.get(r.job_id) ?? [];
    list.push(r.url);
    map.set(r.job_id, list);
  }
  return map;
}

export function listJobs(): JobListItem[] {
  const extra = extraUrlsByJob();
  const analyses = analysesByJob(null);
  const rows = getDb().prepare(`SELECT ${LIST_COLUMNS} FROM jobs ORDER BY first_seen_at DESC, id DESC`).all() as any[];
  return rows.map((r) => toItem(r, extra.get(r.id) ?? [], analyses.get(r.id) ?? []));
}

export function getJobItem(id: number): JobListItem | null {
  const r = getDb().prepare(`SELECT ${LIST_COLUMNS} FROM jobs WHERE id = ?`).get(id);
  if (!r) return null;
  const extra = (getDb().prepare('SELECT url FROM job_urls WHERE job_id = ? ORDER BY id').all(id) as { url: string }[]).map((x) => x.url);
  return toItem(r, extra, analysesByJob(id).get(id) ?? []);
}

/** Find the job a canonical URL already belongs to (primary URL or a merged alternate URL). */
export function findJobIdByUrl(canonicalUrl: string): number | null {
  const r = getDb()
    .prepare('SELECT id FROM jobs WHERE canonical_url = ? UNION SELECT job_id AS id FROM job_urls WHERE url = ? LIMIT 1')
    .get(canonicalUrl, canonicalUrl) as { id: number } | undefined;
  return r?.id ?? null;
}

/** Stored posting date for a URL (only reliable source dates), or null when the URL is unknown. */
export function lookupKnownPosting(url: string): { postedAt: string | null } | null {
  const n = normalizeUrl(url);
  if (!n.ok) return null;
  const id = findJobIdByUrl(n.url);
  if (id == null) return null;
  const r = getDb().prepare('SELECT posted_at, posted_at_source FROM jobs WHERE id = ?').get(id) as { posted_at: string | null; posted_at_source: string };
  return { postedAt: r.posted_at_source === 'source' ? r.posted_at : null };
}

/**
 * Find a job with the same company + title + location (§3.5). When either side has no location,
 * fall back to company + title if that identifies exactly one job.
 */
export function findJobIdByDedupeKey(key: string, incoming: { sourceKey: string; externalId: string | null } | null = null): number | null {
  const db = getDb();
  const prefix = dedupePrefix(key);
  const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
  const candidates = (
    db.prepare("SELECT id, dedupe_key, source_key, external_id FROM jobs WHERE dedupe_key LIKE ? ESCAPE '\\' ORDER BY id").all(`${escaped}%`) as {
      id: number;
      dedupe_key: string;
      source_key: string;
      external_id: string | null;
    }[]
  ).filter(
    // Two different postings on the same board (e.g. the same role opened twice) are not duplicates;
    // the key only links one posting seen in different places.
    (c) => !(incoming && c.source_key === incoming.sourceKey && c.external_id && incoming.externalId && c.external_id !== incoming.externalId),
  );
  const exact = candidates.find((c) => c.dedupe_key === key);
  if (exact) return exact.id;
  const incomingHasLocation = key !== prefix;
  const pool = incomingHasLocation ? candidates.filter((c) => c.dedupe_key === prefix) : candidates;
  return pool.length === 1 ? pool[0].id : null;
}

// ---- Merging collected data -----------------------------------------------------------------

/** Which source's URL should be the primary link: the company's own ATS > generic page > job platforms. */
function sourceRank(sourceKey: string): number {
  if (ATS_SOURCE_KEYS.includes(sourceKey)) return 3;
  if (sourceKey === 'generic') return 2;
  return 1;
}

const DATE_RANK: Record<PostedAtSource, number> = { source: 3, source_republish: 2, relative: 1, first_seen: 0 };

function addAltUrl(jobId: number, url: string, sourceKey: string): void {
  const db = getDb();
  const primaryOwner = db.prepare('SELECT id FROM jobs WHERE canonical_url = ?').get(url) as { id: number } | undefined;
  if (primaryOwner) return; // it's some job's primary URL already
  db.prepare('INSERT OR IGNORE INTO job_urls (job_id, url, source_key) VALUES (?, ?, ?)').run(jobId, url, sourceKey);
}

function mergeInto(jobId: number, raw: RawJob, canon: string, sourceKey: string, companyId: number | null, now: string): void {
  const db = getDb();
  const cur = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as any;
  const incomingRank = sourceRank(sourceKey);
  const currentRank = sourceRank(cur.source_key);
  const better = incomingRank >= currentRank;

  const title = better ? raw.title || cur.title : cur.title ?? raw.title;
  const company = better ? raw.companyName ?? cur.company_name : cur.company_name ?? raw.companyName;
  const location = better ? raw.location ?? cur.location_raw : cur.location_raw ?? raw.location;

  let postedAt = cur.posted_at;
  let postedSource: PostedAtSource = cur.posted_at_source;
  if (raw.postedAt && (DATE_RANK[raw.postedAtSource] > DATE_RANK[postedSource] || (DATE_RANK[raw.postedAtSource] === DATE_RANK[postedSource] && better))) {
    postedAt = raw.postedAt;
    postedSource = raw.postedAtSource;
  }

  let description = cur.description_text;
  let fetchStatus = cur.fetch_status;
  if (raw.descriptionText && cur.fetch_status !== 'manual_text' && (!description || better)) {
    description = raw.descriptionText;
    fetchStatus = 'fetched';
  }

  // Prefer the company's own ATS URL as the primary link; the old primary becomes an alternate.
  let canonical = cur.canonical_url;
  let newSourceKey = cur.source_key;
  if (incomingRank > currentRank && canon !== cur.canonical_url) {
    db.prepare('DELETE FROM job_urls WHERE url = ?').run(canon);
    canonical = canon;
    newSourceKey = sourceKey;
  }

  db.prepare(
    `UPDATE jobs SET canonical_url = ?, source_key = ?, company_id = COALESCE(?, company_id), company_name = ?, title = ?,
       location_raw = ?, posted_at = ?, posted_at_source = ?, description_text = ?, fetch_status = ?,
       external_id = COALESCE(?, external_id), raw_json = CASE WHEN ? THEN ? ELSE raw_json END,
       dedupe_key = ?, last_seen_at = ?, updated_at = ? WHERE id = ?`,
  ).run(
    canonical,
    newSourceKey,
    better ? companyId : null,
    company,
    title,
    location,
    postedAt,
    postedSource,
    description,
    fetchStatus,
    better ? raw.externalId : null,
    better ? 1 : 0,
    raw.raw === undefined ? null : JSON.stringify(raw.raw),
    dedupeKey(company, title, location),
    now,
    now,
    jobId,
  );
  if (canonical !== cur.canonical_url) addAltUrl(jobId, cur.canonical_url, cur.source_key);
}

export type UpsertOutcome = 'new' | 'updated' | 'merged' | 'skipped';

/**
 * Store one collected posting: match by canonical/alternate URL, then by dedupe key; merge into
 * the existing job, or insert a new one when `insertIfNew` (i.e. it's inside the date range).
 */
export function upsertCollectedJob(
  raw: RawJob,
  opts: { sourceKey: string; companyId: number | null; now: string; insertIfNew: boolean },
): { jobId: number | null; outcome: UpsertOutcome } {
  const db = getDb();
  const n = normalizeUrl(raw.url);
  if (!n.ok) throw new Error(`Invalid job URL "${raw.url}": ${n.reason}`);
  const canon = n.url;
  const alts = (raw.altUrls ?? [])
    .map((u) => normalizeUrl(u))
    .filter((r): r is { ok: true; url: string } => r.ok)
    .map((r) => r.url)
    .filter((u) => u !== canon);

  return db.transaction(() => {
    let jobId = findJobIdByUrl(canon);
    for (const a of alts) jobId ??= findJobIdByUrl(a);
    let outcome: UpsertOutcome = 'updated';
    const key = dedupeKey(raw.companyName, raw.title, raw.location);
    if (jobId == null && key) {
      jobId = findJobIdByDedupeKey(key, { sourceKey: opts.sourceKey, externalId: raw.externalId });
      if (jobId != null) outcome = 'merged';
    }
    if (jobId == null) {
      if (!opts.insertIfNew) return { jobId: null, outcome: 'skipped' as const };
      const res = db
        .prepare(
          `INSERT INTO jobs (canonical_url, source_key, company_id, company_name, title, location_raw, posted_at, posted_at_source,
             first_seen_at, last_seen_at, description_text, fetch_status, dedupe_key, external_id, raw_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          canon,
          opts.sourceKey,
          opts.companyId,
          raw.companyName,
          raw.title,
          raw.location,
          raw.postedAt,
          raw.postedAt ? raw.postedAtSource : 'first_seen',
          opts.now,
          opts.now,
          raw.descriptionText,
          raw.descriptionText ? 'fetched' : 'pending',
          key,
          raw.externalId,
          raw.raw === undefined ? null : JSON.stringify(raw.raw),
        );
      jobId = Number(res.lastInsertRowid);
      outcome = 'new';
    } else {
      mergeInto(jobId, raw, canon, opts.sourceKey, opts.companyId, opts.now);
      addAltUrl(jobId, canon, opts.sourceKey);
    }
    for (const a of alts) addAltUrl(jobId, a, opts.sourceKey);
    return { jobId, outcome };
  })();
}

/** Apply a single-posting fetch (fetchJob) to a known job. */
export function applyFetchedJob(jobId: number, raw: RawJob, sourceKey: string, now = nowIso()): void {
  const db = getDb();
  db.transaction(() => {
    const n = normalizeUrl(raw.url);
    const canon = n.ok ? n.url : (db.prepare('SELECT canonical_url FROM jobs WHERE id = ?').get(jobId) as any).canonical_url;
    const other = findJobIdByUrl(canon);
    // If the fetched URL already belongs to a different job, just enrich ours without stealing it.
    const safeCanon = other != null && other !== jobId ? (db.prepare('SELECT canonical_url FROM jobs WHERE id = ?').get(jobId) as any).canonical_url : canon;
    mergeInto(jobId, raw, safeCanon, sourceKey, null, now);
    addAltUrl(jobId, safeCanon, sourceKey);
    for (const a of raw.altUrls ?? []) {
      const na = normalizeUrl(a);
      if (na.ok && findJobIdByUrl(na.url) == null) addAltUrl(jobId, na.url, sourceKey);
    }
  })();
}

/**
 * Save pasted links (§3.2): normalize, dedupe against the DB (by URL, then by company+title when
 * the link reveals them) and within the paste, store with source "manual:<domain>" (or the ATS key
 * for Greenhouse/Lever/Ashby/Workday URLs). Descriptions are fetched later.
 */
export function addLinks(text: string): AddLinksResult {
  const db = getDb();
  const result: AddLinksResult = { added: [], duplicates: [], invalid: [] };
  const seen = new Map<string, string>(); // canonical → first input
  const insert = db.prepare(
    `INSERT INTO jobs (canonical_url, source_key, company_name, title, posted_at_source, first_seen_at, last_seen_at, fetch_status, dedupe_key)
     VALUES (?, ?, ?, ?, 'first_seen', ?, ?, 'pending', ?)`,
  );

  db.transaction(() => {
    const now = nowIso();
    for (const input of splitLinkInput(text)) {
      const n = normalizeUrl(input);
      if (!n.ok) {
        result.invalid.push({ input, reason: n.reason });
        continue;
      }
      if (seen.has(n.url)) {
        result.duplicates.push({ input, url: n.url, jobId: null, reason: 'repeated_in_paste' });
        continue;
      }
      seen.set(n.url, input);
      const existing = findJobIdByUrl(n.url);
      if (existing != null) {
        result.duplicates.push({ input, url: n.url, jobId: existing, reason: 'already_saved' });
        continue;
      }
      let original: string | undefined;
      try {
        original = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`).toString();
      } catch {
        original = undefined;
      }
      const hints = hintsFromUrl(n.url, original);
      const key = hints.title && hints.companyName ? dedupeKey(hints.companyName, hints.title, null) : null;
      const sameJob = key ? findJobIdByDedupeKey(key) : null;
      if (sameJob != null) {
        // Same posting seen elsewhere (e.g. the company's ATS): keep one job, remember this URL.
        addAltUrl(sameJob, n.url, hints.sourceKey);
        result.duplicates.push({ input, url: n.url, jobId: sameJob, reason: 'same_job' });
        continue;
      }
      const res = insert.run(n.url, hints.sourceKey, hints.companyName, hints.title, now, now, key);
      const item = getJobItem(Number(res.lastInsertRowid));
      if (item) result.added.push(item);
    }
  })();

  // Fix up in-paste duplicates of newly added links so the UI can point at the saved job.
  for (const d of result.duplicates) {
    if (d.jobId == null) d.jobId = findJobIdByUrl(d.url);
  }
  return result;
}

export function deleteJobs(ids: number[]): number {
  const db = getDb();
  const stmt = db.prepare('DELETE FROM jobs WHERE id = ?');
  let n = 0;
  db.transaction(() => {
    for (const id of ids) n += stmt.run(id).changes;
  })();
  return n;
}
