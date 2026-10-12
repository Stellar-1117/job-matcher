import type { TaskKey } from '@shared/tasks';

/**
 * Default task prompts. Everything that is the same for every job (instructions, taxonomy, output
 * schema, the candidate) comes before the job, so providers can serve it from the prompt cache.
 */
export const SEED_PROMPTS: Record<TaskKey, string> = {
  job_extraction: `You extract structured data from a job posting. Use ONLY information stated in the posting.
If a field is not stated, return "Unknown" or null. Never guess salary, visa or seniority.
For enum fields you MUST choose from the allowed values below.

Allowed values:
{{taxonomy}}

Return only JSON matching this schema:
{{output_schema}}

Job posting:
<job>
{{job_text}}
</job>`,

  closed_check: `Decide whether this page is an OPEN job posting that currently accepts applications.
Return JSON: {"status": "open" | "closed" | "not_a_job_page", "reason": "..."}

<page>
{{job_text}}
</page>`,

  resume_parse: `Convert this resume into a structured profile. Use only what the resume states.
For each project, capture: name, role, what was built, scale/impact, technologies, domain.
Compute total professional years from dates when possible; otherwise null.

<resume>
{{resume_text}}
</resume>

Return only JSON matching this schema:
{{output_schema}}`,

  pre_score: `Quickly judge how well this candidate fits this job. Be decisive.
Return JSON: {"score": 0-100, "reason": "one sentence"}

Candidate: {{profile_structured}}
Job: {{job_fields}}`,

  matching: `You are an expert technical recruiter evaluating how well a candidate matches a job.
Score each category from 0 to 100 using the rubric. Be strict and consistent:
50 = partial fit, 70 = solid fit, 85+ = exceptional fit. Do not inflate.

Rubric:
- skills: coverage of the job's MUST-HAVE skills with concrete evidence in the resume.
  Nice-to-haves add a little. Missing must-haves weigh heavily.
- domain_fit: overlap between the candidate's industries/problem domains and the job's.
- project_similarity: how closely the candidate's past projects match the job's
  responsibilities and the problems the team solves (scale, type of system, ownership).
- experience_fit: years and seniority vs. what the job requires. Penalize both clear
  under-qualification and heavy over-qualification.
- preferences_fit: fit with the candidate's soft preferences (function, industry,
  company stage, work mode, salary if known).

Rules:
- Every strength MUST cite resume_evidence copied from the resume. If you cannot cite
  evidence, it is not a strength.
- Gaps must be specific ("no Kubernetes experience", "requires 7 years, has 4").
- Do not compute a total score.

Return only JSON matching this schema:
{{output_schema}}

Candidate structured profile:
{{profile_structured}}

Candidate soft preferences:
{{soft_preferences}}

Candidate resume (full text):
<resume>
{{resume_text}}
</resume>

Job structured fields:
{{job_fields}}

Job posting (full text):
<job>
{{job_text}}
</job>`,
};

/**
 * Seeded prompts that later shipped with a cache-friendlier layout. When the active version is still
 * exactly the old seed (never edited), it's upgraded to the new default; edited prompts are left alone.
 */
export const PROMPT_UPGRADES: { task: TaskKey; meta: string; from: string; notes: string }[] = [
  {
    task: 'job_extraction',
    meta: 'prompt_upgrade_job_extraction_v2',
    from: `You extract structured data from a job posting. Use ONLY information stated in the posting.
If a field is not stated, return "Unknown" or null. Never guess salary, visa or seniority.
For enum fields you MUST choose from the allowed values below.

Allowed values:
{{taxonomy}}

Job posting:
<job>
{{job_text}}
</job>

Return only JSON matching this schema:
{{output_schema}}`,
    notes: 'Default prompt v2: schema before the job text so the shared part is served from the prompt cache',
  },
];
