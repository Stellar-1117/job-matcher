import type { ResumeParsed } from '@shared/llm-schemas';
import { runTask } from '../llm';
import { appEvents } from '../events';
import { getResume, getResumeFile, saveParseResult, setParseStatus } from '../repos/profiles';

const inFlight = new Set<number>();

function cleanList(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const v = raw.trim();
    if (!v || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    out.push(v);
  }
  return out;
}

const blankToNull = (s: string | null) => (s && s.trim() ? s.trim() : null);

/** Trim strings, drop empty entries and dedupe lists (case-insensitive). */
export function cleanParsed(p: ResumeParsed): ResumeParsed {
  return {
    name: blankToNull(p.name),
    headline: blankToNull(p.headline),
    total_years_experience: p.total_years_experience != null && p.total_years_experience >= 0 ? p.total_years_experience : null,
    skills: cleanList(p.skills),
    roles: p.roles
      .filter((r) => r.title.trim())
      .map((r) => ({ title: r.title.trim(), company: blankToNull(r.company), start: blankToNull(r.start), end: blankToNull(r.end), summary: blankToNull(r.summary) })),
    projects: p.projects
      .filter((x) => x.name.trim() || x.what_built.trim())
      .map((x) => ({
        name: x.name.trim(),
        role: blankToNull(x.role),
        what_built: x.what_built.trim(),
        scale_impact: blankToNull(x.scale_impact),
        technologies: cleanList(x.technologies),
        domain: blankToNull(x.domain),
      })),
    domains: cleanList(p.domains),
    education: p.education
      .map((e) => ({ degree: blankToNull(e.degree), institution: blankToNull(e.institution), year: blankToNull(e.year) }))
      .filter((e) => e.degree || e.institution),
    languages: cleanList(p.languages),
  };
}

function emit(resumeId: number): void {
  try {
    const r = getResume(resumeId);
    appEvents.emit('resume:updated', { resumeId, profileId: r.profileId, status: r.parseStatus });
  } catch {
    // resume deleted meanwhile
  }
}

/**
 * Run the resume_parse task for one resume version (once per version, or on explicit re-parse).
 * Runs in the background; progress is pushed to the UI via the "resume:updated" event.
 */
export async function parseResume(resumeId: number): Promise<void> {
  if (inFlight.has(resumeId)) return;
  inFlight.add(resumeId);
  try {
    const { text } = getResumeFile(resumeId);
    setParseStatus(resumeId, 'parsing', null);
    emit(resumeId);
    const res = await runTask('resume_parse', { resume_text: text });
    const modelName = res.usedFallback ? `${res.model.display_name} (fallback)` : res.model.display_name;
    saveParseResult(resumeId, cleanParsed(res.data), res.promptVersionId, res.model.id, modelName);
  } catch (e) {
    try {
      setParseStatus(resumeId, 'failed', (e as Error).message ?? String(e));
    } catch {
      // resume deleted meanwhile
    }
  } finally {
    inFlight.delete(resumeId);
    emit(resumeId);
  }
}
