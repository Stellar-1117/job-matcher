/** Welcome to the Jungle link helpers (no Electron imports, so the repos and tests can use them). */

const JOB_PATH = /^\/[a-z]{2}(?:-[a-z]{2})?\/companies\/[^/]+\/jobs\/[^/?#]+/i;

/** Job posting links among the hrefs of a WTTJ page, without query or hash, deduplicated, in page order. */
export function wttjJobUrls(hrefs: string[]): string[] {
  const out = new Set<string>();
  for (const href of hrefs) {
    let u: URL;
    try {
      u = new URL(href, 'https://www.welcometothejungle.com');
    } catch {
      continue;
    }
    if (!/(^|\.)welcometothejungle\.com$/i.test(u.hostname)) continue;
    const m = u.pathname.match(JOB_PATH);
    if (m) out.add(`https://www.welcometothejungle.com${m[0]}`);
  }
  return [...out];
}

/** True for WTTJ pages that list jobs rather than being one (pasting these as a job link is a mistake). */
export function isWttjListingPage(url: string): boolean {
  try {
    const u = new URL(url);
    return /(^|\.)welcometothejungle\.com$/i.test(u.hostname) && !JOB_PATH.test(u.pathname) && /\/(jobs-matches|jobs)\/?$/i.test(u.pathname);
  } catch {
    return false;
  }
}

const jobUrl = (org: string, slug: string) => `https://www.welcometothejungle.com/en/companies/${encodeURIComponent(org)}/jobs/${encodeURIComponent(slug)}`;

/**
 * Job posting links from a WTTJ API response (the Matches page loads its list from the site's
 * JSON API): any object with a job `slug` and its `organization.slug`.
 */
export function wttjJobUrlsFromJson(data: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, depth: number) => {
    if (depth > 12 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    const o = v as Record<string, unknown>;
    const org = o.organization && typeof o.organization === 'object' ? (o.organization as Record<string, unknown>) : null;
    const orgSlug = typeof org?.slug === 'string' ? org.slug : typeof o.organization_slug === 'string' ? o.organization_slug : null;
    if (typeof o.slug === 'string' && o.slug && orgSlug) out.add(jobUrl(orgSlug, o.slug));
    for (const x of Object.values(o)) walk(x, depth + 1);
  };
  walk(data, 0);
  return [...out];
}

/** API calls whose responses may hold the user's matches (not counts, not other people's lists). */
export function isWttjMatchesApi(url: string): boolean {
  try {
    const u = new URL(url);
    return /(^|\.)welcometothejungle\.com$/i.test(u.hostname) && /\/api\//.test(u.pathname) && /match|search\/jobs|recommend/i.test(u.pathname) && !/\/counts\b/.test(u.pathname);
  } catch {
    return false;
  }
}
