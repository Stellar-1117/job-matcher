import type { Preferences } from '@shared/profile';
import { getProfile, getResume } from '../repos/profiles';
import type { TemplateVars } from '../llm/template';

/**
 * The text given to the matching prompt as {{soft_preferences}}: soft preferences plus the parts
 * of the hard filters that the rubric's preferences_fit considers (work mode, salary). Only set
 * values are included, with stable key order so the cached prompt prefix stays identical.
 */
export function renderSoftPreferences(p: Preferences): string {
  const out: Record<string, unknown> = {};
  const s = p.soft;
  if (s.targetFunctions.length) out.target_functions = s.targetFunctions;
  if (s.preferredIndustries.length) out.preferred_industries = s.preferredIndustries;
  if (s.preferredStages.length) out.preferred_company_stages = s.preferredStages;
  if (s.avoidIndustries.length) out.industries_to_avoid = s.avoidIndustries;
  if (p.hard.workModes.enabled && p.hard.workModes.allowed.length) out.work_modes = p.hard.workModes.allowed;
  if (p.hard.salary.enabled && p.hard.salary.min != null) out.minimum_salary = `${p.hard.salary.min} ${p.hard.salary.currency} per ${p.hard.salary.period}`;
  if (s.notes.trim()) out.notes = s.notes.trim();
  return Object.keys(out).length ? JSON.stringify(out, null, 2) : 'No stated preferences.';
}

/** Template variables that describe a profile (its active resume + preferences). */
export function profileTemplateVars(profileId: number): { vars: TemplateVars; resumeId: number } {
  const profile = getProfile(profileId);
  if (!profile.activeResumeId) throw new Error(`Profile "${profile.name}" has no resume yet.`);
  const resume = getResume(profile.activeResumeId);
  if (!resume.structured) throw new Error(`The active resume of "${profile.name}" hasn't been parsed yet.`);
  return {
    resumeId: resume.id,
    vars: {
      resume_text: resume.text,
      profile_structured: JSON.stringify(resume.structured, null, 2),
      soft_preferences: renderSoftPreferences(profile.preferences),
    },
  };
}
