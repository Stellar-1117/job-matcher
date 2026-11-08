import { detectAts } from '../detect';
import { htmlToText } from '../html';
import { toIso } from '../dates';
import type { CompanyRef, RawJob, SourceAdapter, SourceContext } from '../types';

/**
 * SmartRecruiters public Posting API (no key): https://api.smartrecruiters.com/v1/companies/{company}/postings
 * lists postings without descriptions; /postings/{id} returns one with its job ad sections.
 * The job pages themselves (jobs.smartrecruiters.com) answer plain fetches with HTTP 403.
 */

const API = 'https://api.smartrecruiters.com/v1/companies';

interface SrSection {
  title?: string;
  text?: string;
}

interface SrPosting {
  id: string;
  name: string;
  releasedDate?: string;
  company?: { name?: string; identifier?: string };
  location?: { city?: string; region?: string; country?: string; remote?: boolean; hybrid?: boolean; fullLocation?: string };
  typeOfEmployment?: { label?: string };
  experienceLevel?: { label?: string };
  postingUrl?: string;
  jobAd?: { sections?: Record<string, SrSection | undefined> };
}

interface SrList {
  offset: number;
  limit: number;
  totalFound: number;
  content: SrPosting[];
}

const SECTION_ORDER = ['companyDescription', 'jobDescription', 'qualifications', 'additionalInformation'];

function description(p: SrPosting): string | null {
  const sections = p.jobAd?.sections ?? {};
  const keys = [...SECTION_ORDER, ...Object.keys(sections).filter((k) => !SECTION_ORDER.includes(k))];
  const parts: string[] = [];
  for (const k of keys) {
    const s = sections[k];
    const text = s?.text ? htmlToText(s.text).trim() : '';
    if (text) parts.push(s?.title && !text.startsWith(s.title) ? `${s.title}\n${text}` : text);
  }
  return parts.join('\n\n') || null;
}

function locationText(p: SrPosting): string | null {
  const l = p.location;
  if (!l) return null;
  const place = l.fullLocation || [l.city, l.region, l.country?.toUpperCase()].filter(Boolean).join(', ');
  const mode = l.remote ? ' (Remote)' : l.hybrid ? ' (Hybrid)' : '';
  return `${place}${mode}`.trim() || null;
}

function toRaw(p: SrPosting, companyToken: string, fallbackCompany: string | null): RawJob {
  const posted = toIso(p.releasedDate);
  return {
    url: p.postingUrl ?? `https://jobs.smartrecruiters.com/${companyToken}/${p.id}`,
    externalId: p.id,
    title: p.name.trim(),
    companyName: p.company?.name?.trim() || fallbackCompany,
    location: locationText(p),
    postedAt: posted,
    // releasedDate is reset when a posting is republished.
    postedAtSource: posted ? 'source_republish' : 'first_seen',
    descriptionText: description(p),
    raw: {
      id: p.id,
      releasedDate: p.releasedDate,
      location: p.location,
      typeOfEmployment: p.typeOfEmployment?.label,
      experienceLevel: p.experienceLevel?.label,
    },
  };
}

async function posting(company: string, id: string, ctx: SourceContext): Promise<SrPosting> {
  return ctx.http.getJson<SrPosting>(`${API}/${encodeURIComponent(company)}/postings/${encodeURIComponent(id)}`, { signal: ctx.signal });
}

export const smartRecruitersAdapter: SourceAdapter = {
  key: 'smartrecruiters',
  label: 'SmartRecruiters',
  detect(url) {
    const m = detectAts(url);
    return m?.ats === 'smartrecruiters' ? { boardToken: m.boardToken } : null;
  },

  async listJobs(company: CompanyRef, ctx: SourceContext): Promise<RawJob[]> {
    if (!company.boardToken) throw new Error('No SmartRecruiters company identifier');
    const token = company.boardToken;
    const listed: SrPosting[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = await ctx.http.getJson<SrList>(`${API}/${encodeURIComponent(token)}/postings?limit=100&offset=${offset}`, { signal: ctx.signal });
      if (!Array.isArray(page?.content)) throw new Error('Unexpected SmartRecruiters response (no "content" array)');
      listed.push(...page.content);
      if (!page.content.length || listed.length >= page.totalFound || offset >= 2000) break;
    }
    // The list has no descriptions: fetch each posting released inside the window.
    const out: RawJob[] = [];
    for (const p of listed) {
      const released = p.releasedDate ? new Date(p.releasedDate) : null;
      if (released && released < ctx.range.from) {
        out.push(toRaw(p, token, company.name));
        continue;
      }
      out.push(toRaw(await posting(token, p.id, ctx), token, company.name));
    }
    return out;
  },

  async fetchJob(url: string, ctx: SourceContext): Promise<RawJob> {
    const m = detectAts(url);
    if (m?.ats !== 'smartrecruiters' || !m.jobId) throw new Error('Not a SmartRecruiters job URL');
    return toRaw(await posting(m.boardToken, m.jobId, ctx), m.boardToken, null);
  },
};
