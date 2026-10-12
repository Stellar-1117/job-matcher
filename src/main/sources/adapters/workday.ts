import { detectAts } from '../detect';
import { htmlToText } from '../html';
import { parseRelativePosted, toIso } from '../dates';
import type { CompanyRef, RawJob, SourceAdapter, SourceContext } from '../types';

/**
 * Workday career sites (no official public API; this is the JSON endpoint the career site itself uses):
 *   POST https://{tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs   {limit, offset, searchText, appliedFacets}
 *   GET  https://{tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{site}{externalPath}
 * The list only has relative dates ("Posted 3 Days Ago"), sorted newest first.
 */

interface WdPosting {
  title: string;
  externalPath: string;
  locationsText?: string;
  postedOn?: string;
  bulletFields?: string[];
}

interface WdDetail {
  jobPostingInfo: {
    title: string;
    jobDescription?: string;
    location?: string;
    postedOn?: string;
    startDate?: string;
    timeType?: string;
    jobReqId?: string;
    externalUrl?: string;
    country?: { descriptor?: string };
  };
  hiringOrganization?: { name?: string };
}

const PAGE = 20;
const MAX_PAGES = 100;

interface WdSite {
  origin: string;
  tenant: string;
  site: string;
}

function siteFromUrl(url: string): WdSite | null {
  const m = detectAts(url);
  if (m?.ats !== 'workday') return null;
  const [tenant, site] = m.boardToken.split('/');
  return { origin: new URL(url).origin, tenant, site };
}

export const workdayAdapter: SourceAdapter = {
  key: 'workday',
  label: 'Workday',
  detect(url) {
    const m = detectAts(url);
    return m?.ats === 'workday' ? { boardToken: m.boardToken } : null;
  },

  async listJobs(company: CompanyRef, ctx: SourceContext): Promise<RawJob[]> {
    const s = siteFromUrl(company.careersUrl);
    if (!s) throw new Error('Careers URL is not a Workday site URL');
    const endpoint = `${s.origin}/wday/cxs/${s.tenant}/${s.site}/jobs`;
    const out: RawJob[] = [];
    let total = Infinity;
    for (let page = 0; page < MAX_PAGES && page * PAGE < total; page++) {
      const data = await ctx.http.postJson<{ total?: number; jobPostings?: WdPosting[] }>(
        endpoint,
        { appliedFacets: {}, limit: PAGE, offset: page * PAGE, searchText: '' },
        { signal: ctx.signal },
      );
      if (page === 0) {
        if (!Array.isArray(data?.jobPostings)) throw new Error('Unexpected Workday response (no "jobPostings")');
        total = data.total ?? Infinity; // only the first page reports the total
      }
      const postings = data.jobPostings ?? [];
      if (!postings.length) break;
      let anyRecent = false;
      for (const p of postings) {
        const rel = parseRelativePosted(p.postedOn, ctx.now);
        const tooOld =
          (rel?.postedAt && Date.parse(rel.postedAt) < ctx.range.from.getTime() - 24 * 3600_000) ||
          (rel?.postedBefore && Date.parse(rel.postedBefore) < ctx.range.from.getTime());
        if (!tooOld) anyRecent = true;
        out.push({
          url: `${s.origin}/${s.site}${p.externalPath}`,
          externalId: p.bulletFields?.[0] ?? p.externalPath,
          title: p.title.trim(),
          companyName: company.name,
          location: p.locationsText?.trim() || null,
          postedAt: rel?.postedAt ?? null,
          postedAtSource: rel?.postedAt ? 'relative' : 'first_seen',
          postedBefore: rel?.postedBefore ?? null,
          descriptionText: null, // the list has no description; fetched later via fetchJob
          raw: { externalPath: p.externalPath, postedOn: p.postedOn, bulletFields: p.bulletFields },
        });
      }
      // Newest first: once a whole page is older than the window, later pages are too.
      if (!anyRecent) break;
    }
    return out;
  },

  async fetchJob(url: string, ctx: SourceContext): Promise<RawJob> {
    const s = siteFromUrl(url);
    if (!s) throw new Error('Not a Workday job URL');
    const path = new URL(url).pathname.replace(/^\/[a-z]{2}-[A-Z]{2}(?=\/)/, '');
    const jobPath = path.slice(path.indexOf(`/${s.site}/`) + s.site.length + 1);
    if (!jobPath.startsWith('/job/')) throw new Error('Not a Workday job URL');
    const d = await ctx.http.getJson<WdDetail>(`${s.origin}/wday/cxs/${s.tenant}/${s.site}${jobPath}`, { signal: ctx.signal });
    const i = d.jobPostingInfo;
    // startDate is the posting's exact start date; fall back to the relative text.
    const exact = i.startDate ? toIso(`${i.startDate}T00:00:00`) : null;
    const rel = exact ? null : parseRelativePosted(i.postedOn, ctx.now);
    return {
      url: `${s.origin}/${s.site}${jobPath}`,
      externalId: i.jobReqId ?? null,
      title: i.title.trim(),
      companyName: null,
      location: [i.location, i.country?.descriptor].filter(Boolean).join(', ') || null,
      postedAt: exact ?? rel?.postedAt ?? null,
      postedAtSource: exact ? 'source' : rel?.postedAt ? 'relative' : 'first_seen',
      postedBefore: rel?.postedBefore ?? null,
      descriptionText: i.jobDescription ? htmlToText(i.jobDescription) : null,
      raw: { jobReqId: i.jobReqId, startDate: i.startDate, postedOn: i.postedOn, timeType: i.timeType },
    };
  },
};
