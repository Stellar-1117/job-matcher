import { detectAts } from '../detect';
import { htmlToText } from '../html';
import { toIso } from '../dates';
import type { CompanyRef, RawJob, SourceAdapter, SourceContext } from '../types';

/** Lever Postings API: https://api.lever.co/v0/postings/{site}?mode=json (EU: api.eu.lever.co) */

interface LeverPosting {
  id: string;
  text: string;
  createdAt: number;
  hostedUrl: string;
  categories?: { location?: string; commitment?: string; team?: string; department?: string; allLocations?: string[] };
  workplaceType?: string;
  country?: string;
  descriptionPlain?: string;
  description?: string;
  lists?: { text: string; content: string }[];
  additionalPlain?: string;
  salaryRange?: { min?: number; max?: number; currency?: string; interval?: string };
}

function apiBase(careersUrl: string): string {
  return /(^|\/\/)jobs\.eu\.lever\.co/.test(careersUrl) ? 'https://api.eu.lever.co/v0/postings' : 'https://api.lever.co/v0/postings';
}

function toRaw(p: LeverPosting, fallbackCompany: string | null): RawJob {
  const parts = [p.descriptionPlain ?? (p.description ? htmlToText(p.description) : '')];
  for (const l of p.lists ?? []) parts.push(`${l.text}\n${htmlToText(`<ul>${l.content}</ul>`)}`);
  if (p.additionalPlain) parts.push(p.additionalPlain);
  const desc = parts.map((s) => s.trim()).filter(Boolean).join('\n\n');
  const locs = p.categories?.allLocations?.length ? p.categories.allLocations : p.categories?.location ? [p.categories.location] : [];
  const workplace = p.workplaceType && p.workplaceType !== 'unspecified' ? ` (${p.workplaceType})` : '';
  const posted = toIso(p.createdAt);
  return {
    url: p.hostedUrl,
    externalId: p.id,
    title: p.text.trim(),
    companyName: fallbackCompany,
    location: locs.length ? `${locs.join(' / ')}${workplace}` : workplace.trim() || null,
    postedAt: posted,
    postedAtSource: posted ? 'source' : 'first_seen',
    descriptionText: desc || null,
    raw: { id: p.id, createdAt: p.createdAt, categories: p.categories, workplaceType: p.workplaceType, country: p.country, salaryRange: p.salaryRange },
  };
}

export const leverAdapter: SourceAdapter = {
  key: 'lever',
  label: 'Lever',
  detect(url) {
    const m = detectAts(url);
    return m?.ats === 'lever' ? { boardToken: m.boardToken } : null;
  },

  async listJobs(company: CompanyRef, ctx: SourceContext): Promise<RawJob[]> {
    if (!company.boardToken) throw new Error('No Lever site name');
    const data = await ctx.http.getJson<LeverPosting[]>(`${apiBase(company.careersUrl)}/${encodeURIComponent(company.boardToken)}?mode=json`, { signal: ctx.signal });
    if (!Array.isArray(data)) throw new Error('Unexpected Lever response (expected an array)');
    return data.map((p) => toRaw(p, company.name));
  },

  async fetchJob(url: string, ctx: SourceContext): Promise<RawJob> {
    const m = detectAts(url);
    if (m?.ats !== 'lever' || !m.jobId) throw new Error('Not a Lever job URL');
    const p = await ctx.http.getJson<LeverPosting>(`${apiBase(url)}/${encodeURIComponent(m.boardToken)}/${encodeURIComponent(m.jobId)}`, { signal: ctx.signal });
    return toRaw(p, null);
  },
};
