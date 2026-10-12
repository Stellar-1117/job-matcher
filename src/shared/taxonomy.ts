import { z } from 'zod';

export const TaxonomySchema = z.object({
  job_function: z.array(z.string()),
  seniority: z.array(z.string()),
  industry: z.array(z.string()),
  company_stage: z.array(z.string()),
  work_mode: z.array(z.string()),
  employment_type: z.array(z.string()),
  visa_sponsorship: z.array(z.string()),
});
export type Taxonomy = z.infer<typeof TaxonomySchema>;
export type TaxonomyField = keyof Taxonomy;

export const DEFAULT_TAXONOMY: Taxonomy = {
  job_function: [
    'Backend',
    'Frontend',
    'Full-stack',
    'Mobile',
    'Infra/DevOps/SRE',
    'Data Eng',
    'ML/AI',
    'Security',
    'QA',
    'Data Science/Analytics',
    'Product',
    'Design',
    'Other',
  ],
  seniority: ['Intern', 'Entry', 'Mid', 'Senior', 'Staff/Principal', 'Lead/Manager', 'Director+', 'Unknown'],
  industry: [
    'Fintech',
    'Healthcare',
    'E-commerce/Retail',
    'B2B SaaS',
    'AI/ML',
    'Dev tools',
    'Security',
    'Media/Gaming',
    'Education',
    'Mobility/Logistics',
    'Climate/Energy',
    'Gov/Defense',
    'Consulting/Agency',
    'Other',
  ],
  company_stage: ['Early (Seed–A)', 'Growth (B–D)', 'Late/Pre-IPO', 'Public/Enterprise', 'Unknown'],
  work_mode: ['Remote', 'Hybrid', 'Onsite', 'Unknown'],
  employment_type: ['Full-time', 'Contract', 'Part-time', 'Internship', 'Unknown'],
  visa_sponsorship: ['Yes', 'No', 'Not mentioned'],
};

export const TAXONOMY_LABELS: Record<TaxonomyField, string> = {
  job_function: 'Job function',
  seniority: 'Seniority',
  industry: 'Industry',
  company_stage: 'Company stage',
  work_mode: 'Work mode',
  employment_type: 'Employment type',
  visa_sponsorship: 'Visa sponsorship',
};

/** The value used when the LLM returns something outside the allowed list. */
export const TAXONOMY_FALLBACK: Record<TaxonomyField, string> = {
  job_function: 'Other',
  seniority: 'Unknown',
  industry: 'Other',
  company_stage: 'Unknown',
  work_mode: 'Unknown',
  employment_type: 'Unknown',
  visa_sponsorship: 'Not mentioned',
};

/** Render the taxonomy as the text injected into the extraction prompt via {{taxonomy}}. */
export function renderTaxonomy(t: Taxonomy): string {
  return (Object.keys(t) as TaxonomyField[]).map((k) => `- ${k}: ${t[k].join(' | ')}`).join('\n');
}

/** Snap a value onto the allowed list (case-insensitive); unknown values become the field's fallback. */
export function snapToTaxonomy(t: Taxonomy, field: TaxonomyField, value: unknown): string {
  if (typeof value !== 'string') return TAXONOMY_FALLBACK[field];
  const v = value.trim().toLowerCase();
  const hit = t[field].find((allowed) => allowed.toLowerCase() === v);
  return hit ?? TAXONOMY_FALLBACK[field];
}
