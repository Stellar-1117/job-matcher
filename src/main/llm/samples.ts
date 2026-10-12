import type { TaskKey } from '@shared/tasks';
import type { TemplateVars } from './template';

/** Small synthetic inputs used by the "Test route" button in Settings → Task routing. */
const SAMPLE_JOB = `Senior Backend Engineer — Payments (Remote, US)
Acme Pay is a Series B fintech building real-time payment rails for small businesses.
You will design and operate high-throughput services in Go and PostgreSQL on AWS (Kubernetes).
Requirements: 5+ years of backend experience, distributed systems, strong SQL. Nice to have: Kafka, Terraform.
Salary: $170,000–$200,000 per year. Full-time. We are unable to sponsor visas for this role.`;

const SAMPLE_RESUME = `Jordan Lee — Backend Engineer
Experience: Stripe-like startup "PayFlow" (2019–present): built a ledger service in Go handling 2M tx/day; led migration to Kubernetes.
Earlier: "ShopCo" (2016–2019): Python/Django e-commerce checkout, PostgreSQL tuning.
Skills: Go, Python, PostgreSQL, Kafka, AWS, Kubernetes. Languages: English, Spanish.`;

const SAMPLE_PROFILE = JSON.stringify({
  total_years_experience: 8,
  skills: ['Go', 'Python', 'PostgreSQL', 'Kafka', 'AWS', 'Kubernetes'],
  domains: ['payments', 'e-commerce'],
});

const SAMPLE_FIELDS = JSON.stringify({
  job_function: 'Backend',
  seniority: 'Senior',
  industry: 'Fintech',
  work_mode: 'Remote',
  must_have_skills: ['Go', 'PostgreSQL', 'distributed systems'],
  required_years: 5,
});

export const SAMPLE_VARS: Record<TaskKey, TemplateVars> = {
  job_extraction: { job_text: SAMPLE_JOB },
  closed_check: { job_text: SAMPLE_JOB },
  pre_score: { profile_structured: SAMPLE_PROFILE, job_fields: SAMPLE_FIELDS },
  resume_parse: { resume_text: SAMPLE_RESUME },
  matching: {
    profile_structured: SAMPLE_PROFILE,
    soft_preferences: JSON.stringify({ target_functions: ['Backend'], preferred_industries: ['Fintech'] }),
    resume_text: SAMPLE_RESUME,
    job_fields: SAMPLE_FIELDS,
    job_text: SAMPLE_JOB,
  },
};
