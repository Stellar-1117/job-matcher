/**
 * Closed-posting detection by rules (§5 step 2). The `closed_check` LLM task is only used when these
 * are inconclusive and the page text looks odd.
 */

const CLOSED_PATTERNS: RegExp[] = [
  /no longer accepting applications/i,
  /(?:is )?no longer (?:accepting|taking) (?:applications|applicants|candidates)/i,
  /this (?:job|position|posting|role|vacancy|requisition)(?: posting)? (?:has|is) (?:expired|closed|been closed|been filled|been removed|no longer available|no longer open|no longer active)/i,
  /(?:job|position|posting|role|vacancy) (?:has been|was) filled/i,
  /position has been filled/i,
  /(?:job|position|posting|page) (?:you(?:'re| are) looking for )?(?:is |was )?no longer (?:available|exists?|active|open|posted)/i,
  /(?:job|posting|position) (?:not found|could not be found|cannot be found|doesn['’]t exist|does not exist)/i,
  /applications? (?:for this (?:job|position|role) )?(?:are|is|have been) (?:now )?closed/i,
  /this job (?:listing |posting )?has expired/i,
  /(?:the|this) (?:job|position) (?:you (?:are|were) looking for|you requested) (?:is|has been) (?:no longer|closed|removed)/i,
];

/** The first closed phrase found in the page text (only the opening part, where such banners live). */
export function closedPhrase(text: string): string | null {
  const head = text.slice(0, 4000);
  for (const re of CLOSED_PATTERNS) {
    const m = head.match(re);
    if (m) return m[0].trim();
  }
  return null;
}

const LISTING_PATH = /^\/?(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:careers?|jobs?|positions|openings|opportunities|join-us|vacancies|search|job-search|jobs-search|search-jobs)?\/?$/i;

/**
 * A job URL that redirected to a careers listing / home page (a common way closed postings are
 * retired): different final URL, and the final path is a listing root or carries an error flag.
 */
export function isGenericCareersRedirect(requested: string, final: string): boolean {
  let a: URL;
  let b: URL;
  try {
    a = new URL(requested);
    b = new URL(final);
  } catch {
    return false;
  }
  const norm = (u: URL) => `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}`;
  if (norm(a) === norm(b)) return false;
  if (/^(?:true|1)$/i.test(b.searchParams.get('error') ?? '')) return true;
  // Greenhouse/Lever/Ashby send retired postings back to the board root (/<board>).
  const segs = b.pathname.split('/').filter(Boolean);
  if (/(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com)$/.test(b.hostname) && segs.length <= 1) return true;
  if (LISTING_PATH.test(b.pathname)) return true;
  // Workday: redirected away from a /job/ path to the site root.
  if (/myworkdayjobs\.com$/.test(b.hostname) && /\/job\//.test(a.pathname) && !/\/job\//.test(b.pathname)) return true;
  return false;
}

/** Was the posting's validThrough date (JSON-LD) in the past? */
export function expiredByValidThrough(validThrough: string | null | undefined, now: Date): boolean {
  if (!validThrough) return false;
  const t = Date.parse(validThrough);
  // Date-only values mean "through the end of that day".
  return Number.isFinite(t) && t + (/^\d{4}-\d{2}-\d{2}$/.test(validThrough.trim()) ? 86_400_000 : 0) < now.getTime();
}

const JOB_WORDS = /responsibilit|requirement|qualification|experience|what you['’]ll do|about the role|about you|skills|benefits|apply/gi;

/**
 * Text that doesn't read like a job posting: very short, or almost none of the usual section words.
 * Used to decide whether an LLM closed check is worth its cost.
 */
export function looksOdd(text: string): boolean {
  const t = text.trim();
  if (t.length < 700) return true;
  const hits = new Set((t.match(JOB_WORDS) ?? []).map((w) => w.toLowerCase()));
  return hits.size < 2;
}
