export const TASKS = ['job_extraction', 'closed_check', 'pre_score', 'resume_parse', 'matching'] as const;
export type TaskKey = (typeof TASKS)[number];

export interface TaskMeta {
  key: TaskKey;
  label: string;
  description: string;
  /** Whether the prompt for this task includes resume / personal data. */
  personalData: boolean;
  /** Max output tokens for the visible answer (thinking budget is added on top when enabled). */
  maxOutputTokens: number;
  /** Template variables the default prompt uses. */
  variables: string[];
}

export const TASK_META: Record<TaskKey, TaskMeta> = {
  job_extraction: {
    key: 'job_extraction',
    label: 'Job extraction',
    description: 'Extract structured filter fields from a job posting (once per job).',
    personalData: false,
    maxOutputTokens: 4000,
    variables: ['taxonomy', 'job_text', 'output_schema'],
  },
  closed_check: {
    key: 'closed_check',
    label: 'Closed check',
    description: 'Decide whether a page is an open job posting (only when rules are inconclusive).',
    personalData: false,
    maxOutputTokens: 600,
    variables: ['job_text'],
  },
  pre_score: {
    key: 'pre_score',
    label: 'Quick pre-score',
    description: 'Optional cheap fit score used to skip clearly bad matches before full matching.',
    personalData: true,
    maxOutputTokens: 600,
    variables: ['profile_structured', 'job_fields'],
  },
  resume_parse: {
    key: 'resume_parse',
    label: 'Resume parse',
    description: 'Convert resume text into a structured profile (once per resume version).',
    personalData: true,
    maxOutputTokens: 8000,
    variables: ['resume_text', 'output_schema'],
  },
  matching: {
    key: 'matching',
    label: 'Matching',
    description: 'Score one job against one profile (sub-scores, strengths, gaps, summary).',
    personalData: true,
    maxOutputTokens: 6000,
    variables: ['profile_structured', 'soft_preferences', 'resume_text', 'job_fields', 'job_text', 'output_schema'],
  },
};

/** All variables a prompt template may reference. */
export const TEMPLATE_VARIABLES = [
  'job_text',
  'job_fields',
  'resume_text',
  'profile_structured',
  'soft_preferences',
  'taxonomy',
  'output_schema',
] as const;
export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

/**
 * Variables whose value changes from job to job. Everything in a rendered prompt before the first
 * of these is treated as the stable, cacheable prefix.
 */
export const VOLATILE_VARIABLES: TemplateVariable[] = ['job_text', 'job_fields'];
