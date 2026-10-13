import { z } from 'zod';
import type { JobExtraction } from './llm-schemas';
import type { HardFilterResult } from './hardFilters';
import { SUB_SCORE_KEYS, computeTotal, computeVerdict, type SubScoreKey, type Thresholds, type Verdict, type Weights } from './scoring';

// ---- Per job × profile status (§2) ----------------------------------------------------------

export const JOB_STATUSES = ['new', 'reviewed', 'selected', 'exported', 'applied', 'rejected'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  new: 'New',
  reviewed: 'Reviewed',
  selected: 'Selected',
  exported: 'Exported',
  applied: 'Applied',
  rejected: 'Rejected',
};

// ---- Results list ---------------------------------------------------------------------------

/** Extraction fields the results filters use. */
export type ResultFields = Pick<
  JobExtraction,
  | 'job_function'
  | 'seniority'
  | 'industry'
  | 'company_stage'
  | 'work_mode'
  | 'remote_region'
  | 'employment_type'
  | 'country'
  | 'city'
  | 'salary_min'
  | 'salary_max'
  | 'salary_currency'
  | 'salary_period'
  | 'salary_listed'
  | 'visa_sponsorship'
  | 'required_years'
  | 'required_languages'
  | 'must_have_skills'
  | 'nice_to_have_skills'
  | 'tech_stack'
  | 'problem_domains'
>;

export type ResultOutcome = 'matched' | 'hard_filter' | 'pre_score_skip';

/** One row of the Results screen: the latest analysis of a job for the chosen profile. */
export interface ResultRow {
  jobId: number;
  analysisId: number;
  url: string;
  title: string | null;
  companyName: string | null;
  /** Location from the job source (may include the work mode, e.g. "New York (Hybrid)"). */
  location: string | null;
  /** Location as the posting describes it, from the job's extraction (null if not stated or not extracted yet). */
  postingLocation: string | null;
  postedAt: string | null;
  postedAtSource: string;
  firstSeenAt: string;
  sourceKey: string;
  sourceLabel: string;
  isClosed: boolean;
  closedReason: string | null;
  status: JobStatus;
  feedback: -1 | 0 | 1;
  feedbackNote: string | null;
  exportedAt: string | null;
  outcome: ResultOutcome;
  hardFilterPass: boolean;
  hardFilterReasons: string[];
  /** Sub-scores (0–100) when the job was matched; totals are computed from these with the current weights. */
  subScores: Record<SubScoreKey, number> | null;
  preScore: number | null;
  summary: string | null;
  fields: ResultFields | null;
  /** The matching route's model when the analysis was made (the cache key), and who actually answered. */
  modelId: number;
  modelName: string | null;
  promptVersion: number | null;
  /** False when the analysis was made with an older resume version. */
  currentResume: boolean;
  analyzedAt: string;
}

export interface ResultsList {
  profileId: number;
  rows: ResultRow[];
  /** For the "different model" warning: the matching route's model right now. */
  currentModelId: number | null;
  currentModelName: string | null;
  currentPromptVersion: number | null;
}

export interface ResultDetail {
  analysisId: number;
  subScores: Record<SubScoreKey, { score: number; reason: string }> | null;
  strengths: { point: string; resume_evidence: string }[];
  gaps: { point: string; severity: 'high' | 'medium' | 'low' }[];
  summary: string | null;
  preScore: number | null;
  preScoreReason: string | null;
  hardFilters: HardFilterResult[];
  fields: JobExtraction | null;
  extractionModel: string | null;
  modelName: string | null;
  promptVersion: number | null;
  resumeVersion: number | null;
  analyzedAt: string;
  costUsd: number;
}

// ---- Scoring in the UI (no LLM: weights/thresholds apply instantly) ------------------------

export interface Scored {
  total: number | null;
  verdict: Verdict | null;
}

export function scoreRow(row: Pick<ResultRow, 'subScores' | 'outcome'>, weights: Weights, thresholds: Thresholds): Scored {
  if (row.subScores) {
    const total = computeTotal(row.subScores, weights);
    return { total, verdict: computeVerdict(total, thresholds) };
  }
  return { total: null, verdict: row.outcome === 'pre_score_skip' ? 'skip' : null };
}

export function subScoresFromJson(json: string | null): Record<SubScoreKey, number> | null {
  if (!json) return null;
  try {
    const raw = JSON.parse(json) as Record<string, { score: number }>;
    return Object.fromEntries(SUB_SCORE_KEYS.map((k) => [k, Number(raw[k]?.score ?? 0)])) as Record<SubScoreKey, number>;
  } catch {
    return null;
  }
}

// ---- Export (§13) ---------------------------------------------------------------------------

export const ExportOptionsSchema = z.object({
  format: z.enum(['txt', 'csv']),
  /** Extra columns for .txt (off by default: one URL per line). */
  include: z.object({ title: z.boolean(), company: z.boolean(), score: z.boolean() }),
  destination: z.enum(['file', 'clipboard']),
  /** Leave out jobs already exported for this profile. */
  skipExported: z.boolean(),
  /** Table copied to the clipboard: start with a header row (off = rows only, to append to a sheet). */
  clipboardHeader: z.boolean().default(false),
});
export type ExportOptions = z.infer<typeof ExportOptionsSchema>;
export type ExportOptionsInput = z.input<typeof ExportOptionsSchema>;

export interface ExportRow {
  url: string;
  title: string | null;
  company: string | null;
  /** Remote | Hybrid | Onsite, or null when unknown. */
  workType: string | null;
  location: string | null;
  score: number | null;
  verdict: Verdict | null;
  summary: string | null;
}

const MODE = String.raw`fully[- ]remote|remote|hybrid|on[- ]?site|in[- ]office|in[- ]person`;
const WORK_MODE_WORDS = new RegExp(String.raw`\b(?:${MODE})\b`, 'i');

/** Work type for the export: the extracted work mode, else a mode named in the source location ("Seattle (Hybrid)"). */
export function exportWorkType(workMode: string | null | undefined, sourceLocation: string | null): string | null {
  if (workMode && workMode !== 'Unknown') return workMode;
  const m = sourceLocation?.match(WORK_MODE_WORDS)?.[0].toLowerCase();
  if (!m) return null;
  return m.includes('remote') ? 'Remote' : m === 'hybrid' ? 'Hybrid' : 'Onsite';
}

/** A source location without its work-mode words: "New York City (Hybrid)" → "New York City", "Remote - US" → "US". */
export function stripWorkMode(location: string | null): string | null {
  if (!location) return null;
  const s = location
    .replace(new RegExp(String.raw`\(\s*(?:${MODE})\b[^)]*\)`, 'gi'), '')
    .replace(new RegExp(String.raw`^\s*(?:${MODE})\b\s*(?:[-–—:,|/]\s*)?`, 'i'), '')
    .replace(new RegExp(String.raw`\s*(?:[-–—,|/]\s*)?\b(?:${MODE})\s*$`, 'i'), '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return s || null;
}

function csvCell(v: string | number | null): string {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV file columns: company, role, link first (the order of the user's job sheet). */
export const EXPORT_COLUMNS = ['company', 'role', 'link', 'work_type', 'location', 'score', 'verdict', 'summary'] as const;

const columnValues = (r: ExportRow): (string | number | null)[] => [r.company, r.title, r.url, r.workType, r.location, r.score, r.verdict, r.summary];

/** File/clipboard content. CSV gets a UTF-8 BOM and CRLF line ends so Excel opens it correctly. */
export function buildExport(rows: ExportRow[], o: Pick<ExportOptions, 'format' | 'include'>): string {
  if (o.format === 'csv') {
    const lines = [EXPORT_COLUMNS.join(',')];
    for (const r of rows) lines.push(columnValues(r).map(csvCell).join(','));
    return `﻿${lines.join('\r\n')}\r\n`;
  }
  const lines = rows.map((r) => {
    const parts = [r.url];
    if (o.include.title) parts.push(r.title ?? '');
    if (o.include.company) parts.push(r.company ?? '');
    if (o.include.score) parts.push(r.score != null ? String(r.score) : '');
    return parts.join(' | ');
  });
  return `${lines.join('\n')}\n`;
}

/**
 * Clipboard rows laid out like the user's job sheet: Company | Role | Link | Work type | (blank — the
 * sheet's own dropdown column) | Location. Nothing beyond Location, so columns further right are never
 * overwritten. Plain tab-separated text: spreadsheets paste one value per cell and keep the sheet's own
 * formatting and dropdowns (an HTML table would bring its own formatting); URLs become links.
 */
export const SHEET_COLUMNS = ['Company', 'Role', 'Link', 'Work type', '', 'Location'] as const;

export function buildClipboardTable(rows: ExportRow[], header: boolean): string {
  const cell = (v: string | null) => (v == null ? '' : v.replace(/[\t\r\n]+/g, ' ').trim());
  const body = rows.map((r) => [r.company, r.title, r.url, r.workType, null, r.location].map(cell));
  return `${[...(header ? [[...SHEET_COLUMNS]] : []), ...body].map((r) => r.join('\t')).join('\n')}\n`;
}

/** jobs_<profile>_<YYYY-MM-DD>.<ext> with a filesystem-safe profile name. */
export function exportFileName(profileName: string, format: 'txt' | 'csv', now: Date): string {
  const safe = profileName.trim().replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '') || 'profile';
  const d = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return `jobs_${safe}_${d}.${format}`;
}
