/** Secondary dedupe key: the same posting listed at different URLs (§3.5). */

const COMPANY_SUFFIXES = /\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|gmbh|ag|sa|sas|bv|plc|pty|oy|ab|srl|technologies|technology|labs|holdings)\b/g;

function base(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9+#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeCompany(s: string | null | undefined): string {
  if (!s) return '';
  return base(s).replace(COMPANY_SUFFIXES, ' ').replace(/\s+/g, ' ').trim();
}

const TITLE_SYNONYMS: [RegExp, string][] = [
  [/\bsr\b/g, 'senior'],
  [/\bjr\b/g, 'junior'],
  [/\beng\b/g, 'engineer'],
  [/\bengr\b/g, 'engineer'],
  [/\bmgr\b/g, 'manager'],
  [/\bswe\b/g, 'software engineer'],
  [/\bml\b/g, 'machine learning'],
  [/\bfull stack\b/g, 'fullstack'],
  [/\bfront end\b/g, 'frontend'],
  [/\bback end\b/g, 'backend'],
];

export function normalizeTitle(s: string | null | undefined): string {
  if (!s) return '';
  let t = base(s.replace(/\([^)]*\)/g, ' ')); // drop parentheticals like "(Remote)"
  for (const [re, rep] of TITLE_SYNONYMS) t = t.replace(re, rep);
  return t.replace(/\s+/g, ' ').trim();
}

export function normalizeLocation(s: string | null | undefined): string {
  if (!s) return '';
  return base(s)
    .replace(/\bunited states( of america)?\b|\busa\b/g, 'us')
    .replace(/\bunited kingdom\b/g, 'uk')
    .split(' ')
    .filter((w) => w && w !== 'remote' && w !== 'hybrid' && w !== 'onsite')
    .join(' ');
}

/** "company|title|location", or null when company or title is unknown (no reliable key). */
export function dedupeKey(company: string | null | undefined, title: string | null | undefined, location: string | null | undefined): string | null {
  const c = normalizeCompany(company);
  const t = normalizeTitle(title);
  if (!c || !t) return null;
  return `${c}|${t}|${normalizeLocation(location)}`;
}

/** The company+title part of a key, for matching when one side has no location. */
export function dedupePrefix(key: string): string {
  return key.slice(0, key.lastIndexOf('|') + 1);
}
