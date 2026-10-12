import { z } from 'zod';
import type { TaskKey } from './tasks';

/**
 * Zod schemas for every LLM task output. These are the single source of truth: they are rendered
 * into prompts via {{output_schema}}, sent as structured-output schemas where supported, and used
 * to validate every response.
 */

const score = z.number().min(0).max(100);
const strList = z.array(z.string());

/** What the posting itself says about the role — used for exports instead of page titles and URL guesses. */
const postingIdentity = {
  job_title: z
    .string()
    .nullable()
    .describe('The role title exactly as the posting states it, e.g. "Sr. Software Engineer, Team Lead" — without company, site, location or "Careers"/"Open Positions" suffixes. Ignore page titles like "Career Center" or "Candidate Portal".'),
  company_name: z.string().nullable().describe('The hiring company as the posting names it (not the job board, recruiting platform or staffing agency site); null if not stated'),
  location: z
    .string()
    .nullable()
    .describe('Where the job is based as the posting states it, e.g. "New York, NY" or "United States" — without the work mode (no "Remote"/"Hybrid"/"Onsite"); null if not stated'),
};

export const JobExtractionSchema = z.object({
  ...postingIdentity,
  job_function: z.string(),
  seniority: z.string(),
  industry: z.string(),
  company_stage: z.string(),
  work_mode: z.string(),
  remote_region: z.string().nullable().describe('e.g. "US only", "EU time zones"; null if not stated'),
  employment_type: z.string(),
  country: z.string().nullable(),
  city: z.string().nullable(),
  salary_min: z.number().nullable(),
  salary_max: z.number().nullable(),
  salary_currency: z.string().nullable().describe('ISO 4217 code, e.g. USD'),
  salary_period: z.string().nullable().describe('year | month | hour, or null'),
  salary_listed: z.boolean(),
  visa_sponsorship: z.string(),
  required_years: z.number().nullable(),
  required_languages: strList.describe('Human languages required, e.g. ["English", "German"]'),
  must_have_skills: strList,
  nice_to_have_skills: strList,
  tech_stack: strList,
  problem_domains: strList.describe('e.g. payments, search, recommendations, data pipelines, LLM apps'),
  responsibilities: strList.describe('Short phrases'),
});
export type JobExtraction = z.infer<typeof JobExtractionSchema>;

/** Stored extractions made before job_title / company_name / location existed parse with those as null. */
export const StoredJobExtractionSchema = JobExtractionSchema.extend({
  job_title: postingIdentity.job_title.default(null),
  company_name: postingIdentity.company_name.default(null),
  location: postingIdentity.location.default(null),
});

/** True for a stored extraction made before the posting-identity fields existed (worth re-extracting). */
export function isLegacyExtraction(raw: unknown): boolean {
  return !!raw && typeof raw === 'object' && !('job_title' in raw);
}

export const ClosedCheckSchema = z.object({
  status: z.enum(['open', 'closed', 'not_a_job_page']),
  reason: z.string(),
});
export type ClosedCheck = z.infer<typeof ClosedCheckSchema>;

export const ResumeParsedSchema = z.object({
  name: z.string().nullable(),
  headline: z.string().nullable(),
  total_years_experience: z.number().nullable(),
  skills: strList,
  roles: z.array(
    z.object({
      title: z.string(),
      company: z.string().nullable(),
      start: z.string().nullable().describe('YYYY-MM or YYYY'),
      end: z.string().nullable().describe('YYYY-MM, YYYY, or "present"'),
      summary: z.string().nullable(),
    }),
  ),
  projects: z.array(
    z.object({
      name: z.string(),
      role: z.string().nullable(),
      what_built: z.string(),
      scale_impact: z.string().nullable(),
      technologies: strList,
      domain: z.string().nullable(),
    }),
  ),
  domains: strList,
  education: z.array(
    z.object({
      degree: z.string().nullable(),
      institution: z.string().nullable(),
      year: z.string().nullable(),
    }),
  ),
  languages: strList.describe('Human languages the person speaks'),
});
export type ResumeParsed = z.infer<typeof ResumeParsedSchema>;

export const PreScoreSchema = z.object({
  score,
  reason: z.string(),
});
export type PreScore = z.infer<typeof PreScoreSchema>;

const subScore = z.object({ score, reason: z.string() });

export const MatchResultSchema = z.object({
  sub_scores: z.object({
    skills: subScore,
    domain_fit: subScore,
    project_similarity: subScore,
    experience_fit: subScore,
    preferences_fit: subScore,
  }),
  strengths: z.array(z.object({ point: z.string(), resume_evidence: z.string() })),
  gaps: z.array(z.object({ point: z.string(), severity: z.enum(['high', 'medium', 'low']) })),
  summary: z.string(),
});
export type MatchResult = z.infer<typeof MatchResultSchema>;

export const TASK_SCHEMAS = {
  job_extraction: JobExtractionSchema,
  closed_check: ClosedCheckSchema,
  pre_score: PreScoreSchema,
  resume_parse: ResumeParsedSchema,
  matching: MatchResultSchema,
} satisfies Record<TaskKey, z.ZodType>;

export type TaskOutput<T extends TaskKey> = z.infer<(typeof TASK_SCHEMAS)[T]>;

/** JSON Schema text injected into prompts via {{output_schema}} — compact: indentation is paid for as input tokens on every call. */
export function renderOutputSchema(schema: z.ZodType): string {
  const json = z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>;
  delete json.$schema;
  return JSON.stringify(json);
}
