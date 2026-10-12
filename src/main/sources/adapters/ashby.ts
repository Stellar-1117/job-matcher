import { detectAts } from '../detect';
import { htmlToText } from '../html';
import { toIso } from '../dates';
import type { CompanyRef, RawJob, SourceAdapter, SourceContext } from '../types';

/**
 * Ashby public posting API: https://api.ashbyhq.com/posting-api/job-board/{name}?includeCompensation=true
 * `publishedAt` is the *last* publish time (reposts reset it), so dates are marked "source_republish".
 */

interface AshbyJob {
  id: string;
  title: string;
  department?: string;
  team?: string;
  employmentType?: string;
  location?: string;
  secondaryLocations?: { location: string }[];
  publishedAt?: string;
  isListed?: boolean;
  isRemote?: boolean;
  workplaceType?: string;
  jobUrl: string;
  descriptionPlain?: string;
  descriptionHtml?: string;
  compensation?: unknown;
}

function toRaw(j: AshbyJob, fallbackCompany: string | null): RawJob {
  const locs = [j.location, ...(j.secondaryLocations ?? []).map((l) => l.location)].filter(Boolean) as string[];
  const mode = j.workplaceType ? ` (${j.workplaceType})` : j.isRemote ? ' (Remote)' : '';
  const posted = toIso(j.publishedAt);
  return {
    url: j.jobUrl,
    externalId: j.id,
    title: j.title.trim(),
    companyName: fallbackCompany,
    location: locs.length ? `${[...new Set(locs)].join(' / ')}${mode}` : mode.trim() || null,
    postedAt: posted,
    postedAtSource: posted ? 'source_republish' : 'first_seen',
    descriptionText: j.descriptionPlain?.trim() || (j.descriptionHtml ? htmlToText(j.descriptionHtml) : null),
    raw: {
      id: j.id,
      publishedAt: j.publishedAt,
      department: j.department,
      team: j.team,
      employmentType: j.employmentType,
      workplaceType: j.workplaceType,
      isRemote: j.isRemote,
      compensation: j.compensation,
    },
  };
}

async function board(name: string, ctx: SourceContext): Promise<AshbyJob[]> {
  const data = await ctx.http.getJson<{ jobs: AshbyJob[] }>(
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(name)}?includeCompensation=true`,
    { signal: ctx.signal },
  );
  if (!Array.isArray(data?.jobs)) throw new Error('Unexpected Ashby response (no "jobs" array)');
  return data.jobs;
}

export const ashbyAdapter: SourceAdapter = {
  key: 'ashby',
  label: 'Ashby',
  detect(url) {
    const m = detectAts(url);
    return m?.ats === 'ashby' ? { boardToken: m.boardToken } : null;
  },

  async listJobs(company: CompanyRef, ctx: SourceContext): Promise<RawJob[]> {
    if (!company.boardToken) throw new Error('No Ashby job board name');
    return (await board(company.boardToken, ctx)).filter((j) => j.isListed !== false).map((j) => toRaw(j, company.name));
  },

  /** Ashby has no public single-posting endpoint: load the board and pick the posting. */
  async fetchJob(url: string, ctx: SourceContext): Promise<RawJob> {
    const m = detectAts(url);
    if (m?.ats !== 'ashby' || !m.jobId) throw new Error('Not an Ashby job URL');
    const job = (await board(m.boardToken, ctx)).find((j) => j.id === m.jobId || j.jobUrl.includes(m.jobId!));
    if (!job) throw new Error('Posting not found on the Ashby board (it may be closed)');
    return toRaw(job, null);
  },
};
