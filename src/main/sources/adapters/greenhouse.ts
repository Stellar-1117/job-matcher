import { detectAts } from '../detect';
import { decodeEntities, htmlToText } from '../html';
import { toIso } from '../dates';
import type { CompanyRef, RawJob, SourceAdapter, SourceContext } from '../types';

/** Greenhouse Job Board API: https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true */

interface GhJob {
  id: number;
  title: string;
  updated_at: string;
  first_published?: string | null;
  company_name?: string | null;
  location?: { name?: string | null } | null;
  absolute_url: string;
  content?: string | null;
  departments?: { name: string }[];
  offices?: { name: string; location?: string | null }[];
}

const API = 'https://boards-api.greenhouse.io/v1/boards';
export const greenhouseBoardUrl = (token: string, id: number | string) => `https://job-boards.greenhouse.io/${token}/jobs/${id}`;

function toRaw(j: GhJob, token: string, fallbackCompany: string | null, postedAt: string | null): RawJob {
  return {
    url: j.absolute_url || greenhouseBoardUrl(token, j.id),
    altUrls: [greenhouseBoardUrl(token, j.id)],
    externalId: String(j.id),
    title: j.title.trim(),
    companyName: j.company_name?.trim() || fallbackCompany,
    location: j.location?.name?.trim() || null,
    postedAt,
    postedAtSource: postedAt ? 'source' : 'first_seen',
    // first_published ≤ updated_at, so updated_at is an upper bound when first_published is missing.
    postedBefore: postedAt ? null : toIso(j.updated_at),
    descriptionText: j.content ? htmlToText(decodeEntities(j.content)) : null,
    raw: { id: j.id, updated_at: j.updated_at, first_published: j.first_published ?? null, departments: j.departments?.map((d) => d.name), offices: j.offices?.map((o) => o.name) },
  };
}

async function fetchDetail(token: string, id: number | string, ctx: SourceContext): Promise<GhJob> {
  return ctx.http.getJson<GhJob>(`${API}/${encodeURIComponent(token)}/jobs/${id}`, { signal: ctx.signal });
}

export const greenhouseAdapter: SourceAdapter = {
  key: 'greenhouse',
  label: 'Greenhouse',
  detect(url) {
    const m = detectAts(url);
    return m?.ats === 'greenhouse' ? { boardToken: m.boardToken } : null;
  },

  async listJobs(company: CompanyRef, ctx: SourceContext): Promise<RawJob[]> {
    if (!company.boardToken) throw new Error('No Greenhouse board token');
    const token = company.boardToken;
    const data = await ctx.http.getJson<{ jobs: GhJob[] }>(`${API}/${encodeURIComponent(token)}/jobs?content=true`, { signal: ctx.signal });
    if (!Array.isArray(data?.jobs)) throw new Error('Unexpected Greenhouse response (no "jobs" array)');
    const out: RawJob[] = [];
    for (const j of data.jobs) {
      let posted = toIso(j.first_published);
      // The list may omit first_published; the single-job endpoint has it. Only fetch when the
      // job could be in range (first_published ≤ updated_at).
      if (!posted && Date.parse(j.updated_at) >= ctx.range.from.getTime()) {
        try {
          posted = toIso((await fetchDetail(token, j.id, ctx)).first_published);
        } catch (e) {
          if (ctx.signal?.aborted) throw e;
        }
      }
      out.push(toRaw(j, token, company.name, posted));
    }
    return out;
  },

  async fetchJob(url: string, ctx: SourceContext): Promise<RawJob> {
    const m = detectAts(url);
    if (m?.ats !== 'greenhouse' || !m.jobId) throw new Error('Not a Greenhouse job URL');
    const j = await fetchDetail(m.boardToken, m.jobId, ctx);
    return toRaw(j, m.boardToken, null, toIso(j.first_published));
  },
};
