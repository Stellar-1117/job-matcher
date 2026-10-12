import * as cheerio from 'cheerio';
import { extractJsonLdJobPostings, readabilityText } from '../html';
import { toIso } from '../dates';
import type { CompanyRef, RawJob, SourceAdapter, SourceContext } from '../types';

/**
 * Fallback for any other careers page: JSON-LD JobPosting first, then job-looking links on the
 * page (listing), or Readability text (single posting). JavaScript-rendered pages need the hidden
 * browser window from the analysis fetch ladder.
 */

const JOB_PATH = /\/(jobs?|careers?|positions?|openings?|opportunities|vacanc(?:y|ies)|roles?|requisitions?|postings?)\/[^?#]*[a-z0-9]/i;
const NAV_TEXT = /^(jobs?|careers?|see all|view all|all jobs|open positions|open roles|search|apply|apply now|learn more|back|next|previous|home|login|sign in|benefits|teams?|our culture|life at .*)$/i;

export function jobLinksFromHtml(html: string, pageUrl: string): { url: string; title: string }[] {
  const $ = cheerio.load(html);
  const page = new URL(pageUrl);
  const seen = new Set<string>();
  const out: { url: string; title: string }[] = [];
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href') ?? '';
    let u: URL;
    try {
      u = new URL(href, pageUrl);
    } catch {
      return;
    }
    if (!/^https?:$/.test(u.protocol)) return;
    const sameSite = u.hostname.replace(/^www\./, '').endsWith(page.hostname.replace(/^www\./, '').split('.').slice(-2).join('.'));
    if (!sameSite) return;
    if (!JOB_PATH.test(u.pathname) && !u.searchParams.has('gh_jid')) return;
    if (u.pathname.replace(/\/$/, '') === page.pathname.replace(/\/$/, '') && !u.search) return;
    // Prefer a heading inside the link; else the link text.
    const title = ($(a).find('h1,h2,h3,h4,[class*="title"]').first().text() || $(a).text()).replace(/\s+/g, ' ').trim();
    if (title.length < 4 || title.length > 140 || NAV_TEXT.test(title)) return;
    u.hash = '';
    const key = u.toString();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ url: key, title });
  });
  return out;
}

export const genericAdapter: SourceAdapter = {
  key: 'generic',
  label: 'Generic',
  detect: () => null,

  async listJobs(company: CompanyRef, ctx: SourceContext): Promise<RawJob[]> {
    const res = await ctx.http.getText(company.careersUrl, { signal: ctx.signal });
    const postings = extractJsonLdJobPostings(res.text, res.url);
    if (postings.length) {
      return postings
        .filter((p) => p.title)
        .map((p) => {
          const posted = toIso(p.datePosted);
          return {
            url: p.url ?? res.url,
            externalId: p.identifier,
            title: p.title!,
            companyName: p.companyName ?? company.name,
            location: p.location,
            postedAt: posted,
            postedAtSource: posted ? 'source' : 'first_seen',
            descriptionText: p.descriptionText,
            raw: { jsonLd: true, datePosted: p.datePosted, validThrough: p.validThrough, employmentType: p.employmentType },
          } satisfies RawJob;
        });
    }
    const links = jobLinksFromHtml(res.text, res.url);
    if (!links.length) {
      throw new Error(
        'No job postings found on this page. It may render jobs with JavaScript, or use an ATS the app does not recognise — try adding the ATS board URL instead.',
      );
    }
    return links.map((l) => ({
      url: l.url,
      externalId: null,
      title: l.title,
      companyName: company.name,
      location: null,
      postedAt: null,
      postedAtSource: 'first_seen',
      descriptionText: null,
      raw: { link: true },
    }));
  },

  async fetchJob(url: string, ctx: SourceContext): Promise<RawJob> {
    const res = await ctx.http.getText(url, { signal: ctx.signal });
    const [p] = extractJsonLdJobPostings(res.text, res.url);
    if (p?.title) {
      const posted = toIso(p.datePosted);
      return {
        url: res.url,
        externalId: p.identifier,
        title: p.title,
        companyName: p.companyName,
        location: p.location,
        postedAt: posted,
        postedAtSource: posted ? 'source' : 'first_seen',
        descriptionText: p.descriptionText,
        raw: { jsonLd: true, datePosted: p.datePosted, validThrough: p.validThrough, employmentType: p.employmentType },
      };
    }
    const r = await readabilityText(res.text, res.url);
    return {
      url: res.url,
      externalId: null,
      title: r.title ?? url,
      companyName: null,
      location: null,
      postedAt: null,
      postedAtSource: 'first_seen',
      descriptionText: r.text || null,
      raw: { readability: true },
    };
  },
};
