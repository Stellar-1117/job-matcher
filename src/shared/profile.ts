import { z } from 'zod';
import type { ResumeParsed } from './llm-schemas';

// ---- Preferences (§6) -----------------------------------------------------------------------

const list = z.array(z.string());

export const SALARY_PERIODS = ['year', 'month', 'hour'] as const;
export type SalaryPeriod = (typeof SALARY_PERIODS)[number];

/** Hard filters are evaluated in code (no LLM); each one is individually toggleable. */
export const HardFiltersSchema = z.object({
  location: z.object({ enabled: z.boolean(), countries: list, cities: list }),
  workModes: z.object({ enabled: z.boolean(), allowed: list }),
  visa: z.object({ enabled: z.boolean(), needsSponsorship: z.boolean() }),
  salary: z.object({
    enabled: z.boolean(),
    min: z.number().min(0).nullable(),
    currency: z.string().min(3).max(3),
    period: z.enum(SALARY_PERIODS),
  }),
  seniority: z.object({ enabled: z.boolean(), min: z.string().nullable(), max: z.string().nullable() }),
  employmentTypes: z.object({ enabled: z.boolean(), allowed: list }),
  dealBreakers: z.object({ enabled: z.boolean(), keywords: list }),
  languages: z.object({ enabled: z.boolean(), spoken: list }),
});
export type HardFilters = z.infer<typeof HardFiltersSchema>;
export type HardFilterKey = keyof HardFilters;

/** Soft preferences are fed to the matching prompt as {{soft_preferences}}. */
export const SoftPreferencesSchema = z.object({
  targetFunctions: list,
  preferredIndustries: list,
  preferredStages: list,
  avoidIndustries: list,
  notes: z.string(),
});
export type SoftPreferences = z.infer<typeof SoftPreferencesSchema>;

export const PreferencesSchema = z.object({ hard: HardFiltersSchema, soft: SoftPreferencesSchema });
export type Preferences = z.infer<typeof PreferencesSchema>;

export const DEFAULT_PREFERENCES: Preferences = {
  hard: {
    location: { enabled: false, countries: [], cities: [] },
    workModes: { enabled: false, allowed: ['Remote', 'Hybrid', 'Onsite'] },
    visa: { enabled: false, needsSponsorship: false },
    salary: { enabled: false, min: null, currency: 'USD', period: 'year' },
    seniority: { enabled: false, min: null, max: null },
    employmentTypes: { enabled: false, allowed: ['Full-time'] },
    dealBreakers: { enabled: false, keywords: [] },
    languages: { enabled: false, spoken: [] },
  },
  soft: { targetFunctions: [], preferredIndustries: [], preferredStages: [], avoidIndustries: [], notes: '' },
};

export const HARD_FILTER_LABELS: Record<HardFilterKey, { label: string; hint: string }> = {
  location: { label: 'Location', hint: "Job's country/city must be in your lists (remote jobs pass unless their region excludes you). Unknown location passes." },
  workModes: { label: 'Work mode', hint: 'Only these work modes. Unknown passes.' },
  visa: { label: 'Visa sponsorship', hint: 'If you need sponsorship, jobs that explicitly say "no sponsorship" are filtered out.' },
  salary: { label: 'Minimum salary', hint: 'Filters jobs whose listed maximum is below your minimum (only when currency and period are known).' },
  seniority: { label: 'Seniority range', hint: 'Only seniority levels in this range. Unknown passes.' },
  employmentTypes: { label: 'Employment type', hint: 'Only these employment types. Unknown passes.' },
  dealBreakers: { label: 'Deal-breaker keywords', hint: 'Jobs whose text contains any of these words are filtered out (case-insensitive).' },
  languages: { label: 'Languages you speak', hint: "Jobs requiring a language not in this list are filtered out." },
};

/**
 * Parse stored preferences leniently: fields added in later versions fall back to defaults instead
 * of failing the whole profile.
 */
export function parsePreferences(json: string | null | undefined): Preferences {
  let raw: any = {};
  try {
    raw = json ? JSON.parse(json) : {};
  } catch {
    raw = {};
  }
  const hard: Record<string, unknown> = {};
  for (const key of Object.keys(DEFAULT_PREFERENCES.hard) as HardFilterKey[]) {
    const merged = { ...DEFAULT_PREFERENCES.hard[key], ...(raw?.hard?.[key] ?? {}) };
    const parsed = HardFiltersSchema.shape[key].safeParse(merged);
    hard[key] = parsed.success ? parsed.data : DEFAULT_PREFERENCES.hard[key];
  }
  const softParsed = SoftPreferencesSchema.safeParse({ ...DEFAULT_PREFERENCES.soft, ...(raw?.soft ?? {}) });
  return { hard: hard as HardFilters, soft: softParsed.success ? softParsed.data : DEFAULT_PREFERENCES.soft };
}

// ---- Profiles & resumes ---------------------------------------------------------------------

export const PARSE_STATUSES = ['pending', 'parsing', 'done', 'failed'] as const;
export type ParseStatus = (typeof PARSE_STATUSES)[number];

export interface ResumeSummary {
  id: number;
  profileId: number;
  version: number;
  fileName: string;
  fileKind: 'pdf' | 'docx' | 'txt' | 'pasted';
  parseStatus: ParseStatus;
  isActive: boolean;
  edited: boolean;
  createdAt: string;
}

export interface ResumeDetail extends ResumeSummary {
  text: string;
  structured: ResumeParsed | null;
  /** The model's original output, kept so manual edits can be reverted. */
  structuredParsed: ResumeParsed | null;
  parseError: string | null;
  modelName: string | null;
  promptVersion: number | null;
  parsedAt: string | null;
}

export interface ProfileSummary {
  id: number;
  name: string;
  activeResumeId: number | null;
  activeParseStatus: ParseStatus | null;
  resumeCount: number;
  headline: string | null;
  updatedAt: string;
}

export interface ProfileDetail {
  id: number;
  name: string;
  preferences: Preferences;
  activeResumeId: number | null;
  resumes: ResumeSummary[];
  createdAt: string;
  updatedAt: string;
}
