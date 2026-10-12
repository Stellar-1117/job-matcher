import * as cheerio from 'cheerio';
import { detectAts, icimsCompanyToken, prettifyToken } from '../detect';
import { extractJsonLdJobPostings } from '../html';
import { normalizeUrl } from '../url';
import { toIso } from '../dates';
import type { CompanyRef, RawJob, SourceAdapter, SourceContext } from '../types';

/**
 * iCIMS career portals (no public API; server-rendered pages):
 *   list:   https://{tenant}.icims.com/jobs/search?pr={page}&in_iframe=1   (cards: title, requisition id, location fields)
 *   detail: https://{tenant}.icims.com/jobs/{id}/job?in_iframe=1           (JSON-LD JobPosting with datePosted + description)
 * The list has no dates and is ordered by requisition (newest first), so detail pages are fetched
 * for new postings until a run of them falls before the collection window.
 */

const MAX_PAGES = 60;
/** Stop fetching detail pages after this many consecutive postings older than the window. */
const OLD_STREAK_STOP = 8;
const DETAIL_CONCURRENCY = 3;

const PLACEHOLDER = /^(unavailable|n\/a|none|-)$/i;
const NOT_LOCATION = /requisition|job category|category|department|posted|type|id$/i;

interface IcimsCard {
  url: string;
  id: string;
  title: string;
  location: string | null;
  category: string | null;
}

export function parseIcimsSearch(html: string, pageUrl: string): { cards: IcimsCard[]; pageCount: number | null } {
  const $ = cheerio.load(html);
  const cards: IcimsCard[] = [];
  $('.iCIMS_JobsTable .row').each((_, row) => {
    const a = $(row).find('a.iCIMS_Anchor[href*="/jobs/"]').first();
    const href = a.attr('href');
    if (!href) return;
    const n = normalizeUrl(new URL(href, pageUrl).toString());
    if (!n.ok) return;
    const id = n.url.match(/\/jobs\/(\d+)\/job$/)?.[1];
    if (!id) return;
    const title = (a.find('h3').text() || a.attr('title')?.replace(/^\d+\s*-\s*/, '') || a.text()).replace(/\s+/g, ' ').trim();
    const locParts: string[] = [];
    let category: string | null = null;
    $(row)
      .find('.iCIMS_JobHeaderTag')
      .each((_, tag) => {
        const label = $(tag).find('dt').text().replace(/\s+/g, ' ').trim();
        const value = $(tag).find('dd').text().replace(/\s+/g, ' ').trim();
        if (!value || PLACEHOLDER.test(value)) return;
        if (/category/i.test(label)) category = value;
        else if (/location|country|state|city|province|region/i.test(label) || (!NOT_LOCATION.test(label) && $(tag).find('.glyphicons-map-marker').length)) locParts.push(value);
      });
    cards.push({ url: n.url, id, title, location: [...new Set(locParts)].join(', ') || null, category });
  });
  const paging = $('.iCIMS_Paging').text().replace(/\s+/g, ' ');
  const m = paging.match(/Page \d+ of (\d+)/i);
  return { cards, pageCount: m ? Number(m[1]) : null };
}

function detailFromHtml(html: string, url: string, card: Partial<IcimsCard>, fallbackCompany: string | null): RawJob {
  const [p] = extractJsonLdJobPostings(html, url);
  const posted = toIso(p?.datePosted);
  const location = p?.location?.split(/,\s*/).filter((x) => !PLACEHOLDER.test(x)).join(', ') || card.location || null;
  return {
    url,
    externalId: card.id ?? url.match(/\/jobs\/(\d+)\//)?.[1] ?? null,
    title: p?.title ?? card.title ?? url,
    companyName: p?.companyName ?? fallbackCompany,
    location,
    postedAt: posted,
    postedAtSource: posted ? 'source' : 'first_seen',
    descriptionText: p?.descriptionText ?? null,
    raw: { id: card.id, category: card.category ?? null, datePosted: p?.datePosted ?? null, validThrough: p?.validThrough ?? null, employmentType: p?.employmentType ?? null },
  };
}

async function fetchDetailHtml(url: string, ctx: SourceContext): Promise<string> {
  return (await ctx.http.getText(`${url}?in_iframe=1`, { signal: ctx.signal })).text;
}

export const icimsAdapter: SourceAdapter = {
  key: 'icims',
  label: 'iCIMS',
  detect(url) {
    const m = detectAts(url);
    return m?.ats === 'icims' ? { boardToken: m.boardToken } : null;
  },

  async listJobs(company: CompanyRef, ctx: SourceContext): Promise<RawJob[]> {
    if (!company.boardToken) throw new Error('No iCIMS portal name');
    const origin = `https://${company.boardToken}.icims.com`;
    const cards: IcimsCard[] = [];
    const seen = new Set<string>();
    let pages = 1;
    for (let pr = 0; pr < Math.min(pages, MAX_PAGES); pr++) {
      const pageUrl = `${origin}/jobs/search?pr=${pr}&in_iframe=1`;
      const res = await ctx.http.getText(pageUrl, { signal: ctx.signal });
      const parsed = parseIcimsSearch(res.text, res.url);
      if (pr === 0) {
        if (!parsed.cards.length && !/iCIMS_JobsTable/.test(res.text)) {
          throw new Error('No iCIMS job list on this portal page (the portal may require a search or use a different layout).');
        }
        pages = parsed.pageCount ?? 1;
      }
      let added = 0;
      for (const c of parsed.cards) {
        if (seen.has(c.url)) continue;
        seen.add(c.url);
        cards.push(c);
        added++;
      }
      if (!added) break;
    }

    // Dates (and descriptions) live on the detail pages. Known postings reuse the stored date.
    const out: RawJob[] = new Array(cards.length);
    let oldStreak = 0;
    let stop = false;
    const fromMs = ctx.range.from.getTime();
    for (let i = 0; i < cards.length; i += DETAIL_CONCURRENCY) {
      const batch = cards.slice(i, i + DETAIL_CONCURRENCY);
      await Promise.all(
        batch.map(async (c, k) => {
          const idx = i + k;
          const base: RawJob = {
            url: c.url,
            externalId: c.id,
            title: c.title,
            companyName: company.name,
            location: c.location,
            postedAt: null,
            postedAtSource: 'first_seen',
            descriptionText: null,
            raw: { id: c.id, category: c.category },
          };
          const known = ctx.lookupKnown?.(c.url);
          if (known?.postedAt) {
            out[idx] = { ...base, postedAt: known.postedAt, postedAtSource: 'source' };
            return;
          }
          if (stop) {
            // Older than the window by the list's ordering; don't fetch.
            out[idx] = { ...base, postedBefore: ctx.range.from.toISOString() };
            return;
          }
          try {
            out[idx] = detailFromHtml(await fetchDetailHtml(c.url, ctx), c.url, c, company.name);
          } catch (e) {
            if (ctx.signal?.aborted) throw e;
            out[idx] = base;
          }
        }),
      );
      for (const r of out.slice(i, i + batch.length)) {
        if (r.postedAt && Date.parse(r.postedAt) < fromMs) oldStreak++;
        else if (r.postedAt) oldStreak = 0;
      }
      if (oldStreak >= OLD_STREAK_STOP) stop = true;
    }
    return out;
  },

  async fetchJob(url: string, ctx: SourceContext): Promise<RawJob> {
    const m = detectAts(url);
    if (m?.ats !== 'icims' || !m.jobId) throw new Error('Not an iCIMS job URL');
    const canon = `https://${m.boardToken}.icims.com/jobs/${m.jobId}/job`;
    const html = await fetchDetailHtml(canon, ctx);
    return detailFromHtml(html, canon, { id: m.jobId }, prettifyToken(icimsCompanyToken(m.boardToken)));
  },
};
