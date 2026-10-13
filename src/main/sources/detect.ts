/**
 * ATS detection from a URL (the `detect()` half of each source adapter). Works on both company
 * careers-board URLs and single job URLs.
 */

import type { AtsKey } from './types';
export type { AtsKey };

export interface AtsMatch {
  ats: AtsKey;
  /** Board token (Greenhouse board, Lever/Ashby company, Workday "tenant/site"). */
  boardToken: string;
  /** Posting id when the URL points at a single job. */
  jobId: string | null;
}

export function detectAts(url: string): AtsMatch | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const segs = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);

  if (host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io' || /^job-boards\.[a-z]+\.greenhouse\.io$/.test(host)) {
    if (segs[0] === 'embed') {
      const board = u.searchParams.get('for');
      return board ? { ats: 'greenhouse', boardToken: board, jobId: u.searchParams.get('token') } : null;
    }
    if (!segs[0]) return null;
    return { ats: 'greenhouse', boardToken: segs[0], jobId: segs[1] === 'jobs' && segs[2] ? segs[2] : null };
  }
  if (host === 'boards-api.greenhouse.io') {
    const i = segs.indexOf('boards');
    if (i >= 0 && segs[i + 1]) return { ats: 'greenhouse', boardToken: segs[i + 1], jobId: segs[i + 2] === 'jobs' ? segs[i + 3] ?? null : null };
  }

  if (host === 'jobs.lever.co' || host === 'jobs.eu.lever.co') {
    if (!segs[0]) return null;
    return { ats: 'lever', boardToken: segs[0], jobId: segs[1] ?? null };
  }

  if (host === 'jobs.ashbyhq.com') {
    if (!segs[0]) return null;
    return { ats: 'ashby', boardToken: segs[0], jobId: segs[1] ?? null };
  }

  const wd = host.match(/^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/);
  if (wd) {
    const rest = /^[a-z]{2}-[A-Z]{2}$/.test(segs[0] ?? '') ? segs.slice(1) : segs;
    if (!rest[0]) return null;
    const jobIdx = rest.indexOf('job');
    const last = jobIdx >= 0 ? rest[rest.length - 1] : null;
    const req = last?.match(/_([A-Za-z0-9-]+)$/)?.[1] ?? null;
    return { ats: 'workday', boardToken: `${wd[1]}/${rest[0]}`, jobId: req };
  }

  // iCIMS career portals: {tenant}.icims.com, jobs at /jobs/{id}/{slug}/job
  const ic = host.match(/^([a-z0-9-]+)\.icims\.com$/);
  if (ic && !ICIMS_NON_TENANTS.has(ic[1])) {
    const jobId = segs[0] === 'jobs' && /^\d+$/.test(segs[1] ?? '') ? segs[1] : null;
    return { ats: 'icims', boardToken: ic[1], jobId };
  }

  return null;
}

const ICIMS_NON_TENANTS = new Set(['www', 'community', 'developer', 'developers', 'support', 'status', 'login', 'api', 'cdn']);

/** "careers-acme" / "globalcareers-acme" / "uscareers-acme" → "acme". */
export function icimsCompanyToken(tenant: string): string {
  return tenant.replace(/^(?:[a-z]*careers|jobs|external|internal|apply)-/i, '') || tenant;
}

/** "acme-corp" → "Acme Corp". Board tokens are usually the company slug. */
export function prettifyToken(token: string): string {
  return token
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export interface UrlHints {
  sourceKey: string;
  companyName: string | null;
  title: string | null;
}

/**
 * Best-effort source, company and title from the URL alone (real data comes from fetching later).
 * `originalUrl` is the link as pasted, which may carry a descriptive slug the canonical form drops.
 */
export function hintsFromUrl(url: string, originalUrl?: string): UrlHints {
  const ats = detectAts(url);
  if (ats) {
    const company = ats.ats === 'workday' ? ats.boardToken.split('/')[0] : ats.ats === 'icims' ? icimsCompanyToken(ats.boardToken) : ats.boardToken;
    return { sourceKey: ats.ats, companyName: prettifyToken(company), title: null };
  }
  const u = new URL(url);
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const hints: UrlHints = { sourceKey: `manual:${host}`, companyName: null, title: null };
  if (host === 'linkedin.com') {
    // LinkedIn slugs look like "<title>-at-<company>-<id>".
    let slug = '';
    try {
      slug = new URL(originalUrl ?? url).pathname.match(/\/jobs\/view\/([^/]+)/)?.[1] ?? '';
    } catch {
      // unparsable original: no slug hints
    }
    const m = slug.match(/^(.+)-at-(.+)-\d{6,}$/);
    if (m) {
      hints.title = prettifyToken(m[1]);
      hints.companyName = prettifyToken(m[2]);
    }
  }
  return hints;
}
