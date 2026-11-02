import * as cheerio from 'cheerio';
import { HttpError, type HttpClient } from '../net/http';
import { adapterFor } from '../sources';
import { detectAts } from '../sources/detect';
import { parseRelativePosted, toIso } from '../sources/dates';
import { isZipRecruiterUrl, parseZipRecruiterPage } from '../sources/ziprecruiter';
import { extractJsonLdJobPostings, readabilityText } from '../sources/html';
import type { RawJob } from '../sources/types';
import { closedPhrase, expiredByValidThrough, isGenericCareersRedirect } from './closed';

/**
 * The fetch ladder (§3.3): ATS API → plain HTTP (JSON-LD, then Readability) → hidden browser
 * window → unreadable (needs a manual paste). Closed postings are recognised on the way.
 */

export interface RenderedPage {
  html: string;
  /** Final URL after redirects. */
  url: string;
  /** HTTP status of the main document, when known. */
  status: number | null;
}
export type PageRenderer = (url: string, opts: { signal?: AbortSignal }) => Promise<RenderedPage>;

export interface FetchDeps {
  http: HttpClient;
  /** Hidden-browser renderer; null where no browser is available (tests, or disabled). */
  render: PageRenderer | null;
  signal?: AbortSignal;
  now: Date;
}

export type FetchVia = 'ats' | 'http' | 'browser';

export type FetchResult =
  | {
      kind: 'text';
      text: string;
      via: FetchVia;
      /** Structured data for the job (ATS API or JSON-LD) to merge into the stored job, if any. */
      raw: RawJob | null;
      /** Source key to merge `raw` under (the ATS key for ATS data). */
      rawSourceKey: string | null;
      /** Page title, for jobs that don't have a title yet. */
      pageTitle: string | null;
    }
  | { kind: 'closed'; reason: string; via: FetchVia }
  | { kind: 'unreadable'; reason: string };

/** Minimum readable description length; shorter text is treated as "not the job description". */
export const MIN_TEXT_CHARS = 250;

/** Why the text can't be the job description (login wall, bot check, …), or null when it looks fine. */
export function assessText(text: string): string | null {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return 'no readable text';
  if (/captcha|verify (?:that )?you are (?:a )?human|are you a robot|unusual traffic|access denied|request (?:was )?blocked|checking your browser|attention required/i.test(t) && t.length < 3000)
    return 'blocked by a bot check';
  if (/(?:sign|log) ?in (?:to|with) (?:view|see|continue|apply|access)|join (?:linkedin|now) to (?:see|view)|create an account to (?:view|see|apply)|please (?:sign|log) ?in/i.test(t) && t.length < 2500)
    return 'behind a login wall';
  if (/enable javascript|requires javascript|javascript is (?:disabled|required)|turn on javascript/i.test(t) && t.length < 1500) return 'needs JavaScript';
  if (t.length < MIN_TEXT_CHARS) return `page text too short (${t.length} characters)`;
  return null;
}

type PageRead = { kind: 'text' | 'closed'; result: FetchResult } | { kind: 'weak'; reason: string };

/**
 * Work mode a page states outside the description: Welcome to the Jungle puts it in the page title
 * ("… · Permanent contract · Fully-remote"), and JSON-LD may mark the posting TELECOMMUTE.
 */
export function pageWorkMode(html: string, pageUrl: string, jsonLdRemote: boolean): 'Remote' | 'Hybrid' | 'Onsite' | null {
  let host = '';
  try {
    host = new URL(pageUrl).hostname;
  } catch {
    // unparsable URL: no site rule
  }
  if (/(^|\.)welcometothejungle\.com$/i.test(host)) {
    const title = cheerio.load(html)('title').first().text();
    if (/fully[- ]remote|full remote|télétravail total/i.test(title)) return 'Remote';
    if (/a few days at home|occasional remote|partial remote|télétravail (?:fréquent|occasionnel)/i.test(title)) return 'Hybrid';
    if (/no remote work|pas de télétravail/i.test(title)) return 'Onsite';
  }
  return jsonLdRemote ? 'Remote' : null;
}

/** Interpret one loaded page (from plain HTTP or the browser). */
async function readPage(requested: string, page: RenderedPage, via: 'http' | 'browser', now: Date): Promise<PageRead> {
  const label = via === 'http' ? 'page' : 'browser';
  if (page.status === 404 || page.status === 410) return { kind: 'closed', result: { kind: 'closed', via, reason: `The posting page returns HTTP ${page.status}` } };
  if (isGenericCareersRedirect(requested, page.url)) {
    return { kind: 'closed', result: { kind: 'closed', via, reason: `The link now redirects to ${page.url} (a careers listing) — the posting was probably taken down` } };
  }
  if (page.status != null && page.status >= 400) return { kind: 'weak', reason: `${label}: HTTP ${page.status}` };

  const posting = extractJsonLdJobPostings(page.html, page.url).find((p) => p.descriptionText && p.title);
  if (posting) {
    if (expiredByValidThrough(posting.validThrough, now)) {
      return { kind: 'closed', result: { kind: 'closed', via, reason: `The posting expired on ${posting.validThrough} (validThrough)` } };
    }
    // The work mode often sits outside the description; state it on top so extraction sees it.
    const mode = pageWorkMode(page.html, page.url, posting.remote);
    const text = mode ? `Work mode: ${mode}\n\n${posting.descriptionText!}` : posting.descriptionText!;
    const phrase = closedPhrase(text) ?? closedPhrase(bodyText(page.html));
    if (phrase) return { kind: 'closed', result: { kind: 'closed', via, reason: `The page says "${phrase}"` } };
    if (!assessText(text)) {
      const posted = toIso(posting.datePosted);
      const raw: RawJob = {
        url: requested,
        externalId: posting.identifier,
        title: posting.title!,
        companyName: posting.companyName,
        location: posting.location,
        postedAt: posted,
        postedAtSource: posted ? 'source' : 'first_seen',
        descriptionText: text,
        raw: { jsonLd: true, datePosted: posting.datePosted, validThrough: posting.validThrough, employmentType: posting.employmentType },
      };
      return { kind: 'text', result: { kind: 'text', text, via, raw, rawSourceKey: null, pageTitle: posting.title } };
    }
  }

  // Site-specific pages that Readability gets wrong.
  if (isZipRecruiterUrl(page.url)) {
    const zr = parseZipRecruiterPage(page.html);
    if (zr && !assessText(zr.text)) {
      const phrase = closedPhrase(zr.text);
      if (phrase) return { kind: 'closed', result: { kind: 'closed', via, reason: `The page says "${phrase}"` } };
      const rel = parseRelativePosted(zr.postedText, now);
      const raw: RawJob | null = zr.title
        ? {
            url: requested,
            externalId: null,
            title: zr.title,
            companyName: zr.companyName,
            location: zr.location,
            postedAt: rel?.postedAt ?? null,
            postedAtSource: rel?.postedAt ? 'relative' : 'first_seen',
            descriptionText: zr.text,
            raw: { site: 'ziprecruiter', posted: zr.postedText },
          }
        : null;
      return { kind: 'text', result: { kind: 'text', text: zr.text, via, raw, rawSourceKey: null, pageTitle: zr.title } };
    }
  }

  const r = await readabilityText(page.html, page.url);
  const phrase = closedPhrase(r.text) ?? closedPhrase(bodyText(page.html));
  if (phrase) return { kind: 'closed', result: { kind: 'closed', via, reason: `The page says "${phrase}"` } };
  const problem = assessText(r.text);
  if (problem) return { kind: 'weak', reason: `${label}: ${problem}` };
  return { kind: 'text', result: { kind: 'text', text: r.text, via, raw: null, rawSourceKey: null, pageTitle: r.title } };
}

/** Visible text at the top of the page (closed banners often sit outside the main article). */
function bodyText(html: string): string {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg, template').remove();
  return $('body').text().replace(/\s+/g, ' ').slice(0, 6000);
}

const isAbort = (e: unknown, signal?: AbortSignal) => !!signal?.aborted || (e as Error)?.name === 'AbortError';

export async function fetchDescription(url: string, deps: FetchDeps): Promise<FetchResult> {
  const { signal, now } = deps;
  const problems: string[] = [];

  // 1. ATS API, when the link belongs to a supported ATS.
  const ats = detectAts(url);
  if (ats?.jobId) {
    const adapter = adapterFor(ats.ats);
    if (adapter.fetchJob) {
      try {
        const raw = await adapter.fetchJob(url, { http: deps.http, signal, now, range: { from: new Date(0), to: now } });
        const text = raw.descriptionText?.trim() ?? '';
        const phrase = text ? closedPhrase(text) : null;
        if (phrase) return { kind: 'closed', via: 'ats', reason: `The posting says "${phrase}"` };
        if (!assessText(text)) return { kind: 'text', text, via: 'ats', raw, rawSourceKey: ats.ats, pageTitle: raw.title };
        problems.push(`${adapter.label} API: ${assessText(text)}`);
      } catch (e) {
        if (isAbort(e, signal)) throw e;
        if (e instanceof HttpError && (e.status === 404 || e.status === 410)) {
          return { kind: 'closed', via: 'ats', reason: `${adapter.label} no longer lists this posting (HTTP ${e.status})` };
        }
        if (/not found on the Ashby board/i.test((e as Error).message)) return { kind: 'closed', via: 'ats', reason: 'Ashby no longer lists this posting' };
        problems.push(`${adapter.label} API: ${(e as Error).message}`);
      }
    }
  }

  // 2. Plain HTTP GET → JSON-LD JobPosting → Readability.
  try {
    const res = await deps.http.getText(url, { signal, allowErrorStatus: true });
    const read = await readPage(url, { html: res.text, url: res.url, status: res.status }, 'http', now);
    if (read.kind !== 'weak') return read.result;
    problems.push(read.reason);
  } catch (e) {
    if (isAbort(e, signal)) throw e;
    problems.push(`page: ${(e as Error).message}`);
  }

  // 3. Hidden browser window for JavaScript-rendered pages.
  if (deps.render) {
    try {
      const page = await deps.render(url, { signal });
      const read = await readPage(url, page, 'browser', now);
      if (read.kind !== 'weak') return read.result;
      problems.push(read.reason);
    } catch (e) {
      if (isAbort(e, signal)) throw e;
      problems.push(`browser: ${(e as Error).message}`);
    }
  }

  // 4. Give up: the job goes to the "Needs manual paste" queue.
  return { kind: 'unreadable', reason: problems.join(' · ') || 'no readable text' };
}
