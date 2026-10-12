import type { WttjImport, WttjMatch, WttjState } from '@shared/wttj';
import { addLinks, findJobIdByUrl, getJobItem } from '../repos/jobs';
import { getMeta, setMeta } from '../repos/settings';
import { normalizeUrl, splitLinkInput } from '../sources/url';
import { wttjJobUrls } from '../sources/wttjLinks';
import { readWttjMatches } from '../sources/wttj';
import { appEvents } from '../events';

const META_KEY = 'wttj_last_import';

type StoredImport = { importedAt: string; matches: Pick<WttjMatch, 'url' | 'jobId' | 'status'>[] };

let importing = false;

/** Fill in each match's current title, company and analyzed profiles. */
function withJobDetails(stored: StoredImport): WttjImport {
  return {
    importedAt: stored.importedAt,
    matches: stored.matches.map((m) => {
      const job = m.jobId != null ? getJobItem(m.jobId) : null;
      return { ...m, jobId: job ? m.jobId : null, title: job?.title ?? null, companyName: job?.companyName ?? null, analyses: job?.analyses ?? [] };
    }),
  };
}

export function wttjState(): WttjState {
  const raw = getMeta(META_KEY);
  let last: StoredImport | null = null;
  try {
    last = raw ? (JSON.parse(raw) as StoredImport) : null;
  } catch {
    last = null;
  }
  return { lastImport: last ? withJobDetails(last) : null, importing };
}

/** Save the given matches page links as jobs; each is marked new or already saved. */
export function saveWttjMatches(urls: string[], now = new Date()): WttjImport {
  const r = addLinks(urls.join('\n'));
  const added = new Set(r.added.map((j) => j.id));
  const matches: StoredImport['matches'] = [];
  for (const u of urls) {
    const n = normalizeUrl(u);
    if (!n.ok) continue;
    const jobId = findJobIdByUrl(n.url);
    matches.push({ url: n.url, jobId, status: jobId != null && added.has(jobId) ? 'new' : 'already_saved' });
  }
  const stored: StoredImport = { importedAt: now.toISOString(), matches };
  setMeta(META_KEY, JSON.stringify(stored));
  if (added.size) appEvents.emit('jobs:updated', { count: added.size });
  return withJobDetails(stored);
}

/** Read the signed-in user's matches page and save its jobs. */
export async function importWttjMatches(): Promise<WttjImport> {
  if (importing) throw new Error('An import is already running.');
  importing = true;
  try {
    const urls = await readWttjMatches();
    if (!urls.length) throw new Error('No jobs found on your Welcome to the Jungle matches page.');
    return saveWttjMatches(urls);
  } finally {
    importing = false;
  }
}

/** Save WTTJ job links copied from the Matches page in the user's own browser (the bookmarklet). */
export function importWttjLinks(text: string): WttjImport {
  const urls = wttjJobUrls(splitLinkInput(text));
  if (!urls.length) throw new Error('No Welcome to the Jungle job links found in the pasted text.');
  return saveWttjMatches(urls);
}
