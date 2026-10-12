/**
 * URL normalization for job links: one canonical form per posting so the same job pasted from
 * different places (tracking params, locale segments, "/apply" pages, www.) is stored once.
 */

const TRACKING_PARAMS = new Set([
  'ref',
  'ref_src',
  'ref_url',
  'referrer',
  'refid',
  'gh_src',
  'trk',
  'trkinfo',
  'trackingid',
  'lipi',
  'gclid',
  'gbraid',
  'wbraid',
  'fbclid',
  'msclkid',
  'dclid',
  'yclid',
  'twclid',
  'mc_cid',
  'mc_eid',
  '_hsenc',
  '_hsmi',
  'igshid',
  'li_fat_id',
  'lever-source',
  'lever-origin',
  'lever-via',
  'source_ref',
  'src',
]);

/** Extra params that are only tracking noise on ATS hosts (elsewhere they may identify the page). */
const ATS_TRACKING_PARAMS = new Set(['source', 'sourcetype', 'jobsource', 'codes', 'in_iframe', 'hub', 'mobile', 'width', 'height', 'bga', 'needsredirect', 'jan1offset', 'jun1offset']);

function isAtsHost(host: string): boolean {
  return /(^|\.)greenhouse\.io$|(^|\.)lever\.co$|(^|\.)ashbyhq\.com$|myworkdayjobs\.com$|myworkdaysite\.com$|\.icims\.com$/.test(host);
}

function isTrackingParam(key: string, host: string): boolean {
  const k = key.toLowerCase();
  if (k.startsWith('utm_') || k.startsWith('utm-')) return true;
  if (TRACKING_PARAMS.has(k)) return true;
  return isAtsHost(host) && ATS_TRACKING_PARAMS.has(k);
}

export type NormalizeResult = { ok: true; url: string } | { ok: false; reason: string };

export function normalizeUrl(raw: string): NormalizeResult {
  let input = raw.trim().replace(/^<|>$/g, '').replace(/^["']|["']$/g, '');
  input = input.replace(/[),.;]+$/, '');
  if (!input) return { ok: false, reason: 'Empty' };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    if (/^[\w-]+(\.[\w-]+)+(\/|$|\?)/.test(input)) input = `https://${input}`;
    else return { ok: false, reason: 'Not a URL' };
  }

  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return { ok: false, reason: 'Not a valid URL' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: 'Only http(s) links are supported' };
  if (!u.hostname.includes('.')) return { ok: false, reason: 'Not a public web address' };

  u.protocol = 'https:';
  u.hash = '';
  u.username = '';
  u.password = '';
  u.port = '';
  let host = u.hostname.toLowerCase().replace(/^www\./, '');

  // --- site-specific canonical forms -------------------------------------------------------
  if (host === 'linkedin.com' || host.endsWith('.linkedin.com')) {
    const current = u.searchParams.get('currentJobId');
    const view = u.pathname.match(/\/jobs\/view\/(?:[^/]*?-)?(\d{6,})\/?/);
    const id = view?.[1] ?? (current && /^\d+$/.test(current) ? current : null);
    if (id) return { ok: true, url: `https://linkedin.com/jobs/view/${id}` };
    host = 'linkedin.com';
  }

  if (/(^|\.)indeed\.[a-z.]+$/.test(host)) {
    const jk = u.searchParams.get('jk') ?? u.searchParams.get('vjk');
    if (jk) return { ok: true, url: `https://${host.replace(/^[a-z]{2}\./, '')}/viewjob?jk=${jk}` };
  }

  if (host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io' || host.endsWith('.greenhouse.io')) {
    // Embedded form: /embed/job_app?for=<board>&token=<id>
    if (u.pathname.startsWith('/embed/job_app')) {
      const board = u.searchParams.get('for');
      const id = u.searchParams.get('token');
      if (board && id) return { ok: true, url: `https://job-boards.greenhouse.io/${board}/jobs/${id}` };
    }
    const m = u.pathname.match(/^\/([^/]+)\/jobs\/(\d+)/);
    if (m && (host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io')) {
      return { ok: true, url: `https://job-boards.greenhouse.io/${m[1]}/jobs/${m[2]}` };
    }
  }

  // iCIMS: /jobs/{id}/{slug}/job[/...] → /jobs/{id}/job (the slug is cosmetic; iframe/hub params are noise).
  if (/^[a-z0-9-]+\.icims\.com$/.test(host)) {
    const m = u.pathname.match(/^\/jobs\/(\d+)(?:\/|$)/);
    if (m) return { ok: true, url: `https://${host}/jobs/${m[1]}/job` };
  }

  let path = u.pathname;
  if (/(^|\.)lever\.co$/.test(host)) path = path.replace(/\/apply\/?$/, '');
  if (host === 'jobs.ashbyhq.com') path = path.replace(/\/application\/?$/, '');
  if (/myworkdayjobs\.com$/.test(host)) {
    path = path.replace(/^\/[a-z]{2}-[A-Z]{2}(?=\/)/, ''); // locale segment
    path = path.replace(/\/apply(\/.*)?$/, '');
  }

  // Remaining query params: drop tracking, sort the rest for a stable key.
  const kept = [...u.searchParams.entries()].filter(([k]) => !isTrackingParam(k, host));
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = kept.length ? `?${new URLSearchParams(kept).toString()}` : '';

  if (path.length > 1) path = path.replace(/\/+$/, '');
  if (path === '/') path = '';
  return { ok: true, url: `https://${host}${path}${query}` };
}

/** Split pasted text into link candidates: one per line, also tolerating spaces/commas between links. */
export function splitLinkInput(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
