import { detectAts, icimsCompanyToken, prettifyToken } from './detect';
import { siteName } from './html';
import { normalizeUrl } from './url';
import { greenhouseAdapter } from './adapters/greenhouse';
import { leverAdapter } from './adapters/lever';
import { ashbyAdapter } from './adapters/ashby';
import { workdayAdapter } from './adapters/workday';
import { icimsAdapter } from './adapters/icims';
import { genericAdapter } from './adapters/generic';
import type { HttpClient } from '../net/http';
import type { AdapterKey, SourceAdapter } from './types';
import { isWttjListingPage } from './wttjLinks';

export const ADAPTERS: Record<AdapterKey, SourceAdapter> = {
  greenhouse: greenhouseAdapter,
  lever: leverAdapter,
  ashby: ashbyAdapter,
  workday: workdayAdapter,
  icims: icimsAdapter,
  generic: genericAdapter,
};

export function adapterFor(key: string): SourceAdapter {
  return ADAPTERS[key as AdapterKey] ?? genericAdapter;
}

/** Find an ATS board embedded in (or linked from) a company careers page. */
export function detectEmbeddedAts(html: string): { atsType: AdapterKey; boardToken: string; boardUrl: string } | null {
  const patterns: [AdapterKey, RegExp, (m: RegExpMatchArray) => string][] = [
    ['greenhouse', /boards(?:-api)?\.greenhouse\.io\/(?:v1\/boards\/|embed\/job_board(?:\/js)?\?for=)([A-Za-z0-9_-]+)/, (m) => `https://job-boards.greenhouse.io/${m[1]}`],
    ['greenhouse', /job-boards(?:\.[a-z]+)?\.greenhouse\.io\/([A-Za-z0-9_-]+)/, (m) => `https://job-boards.greenhouse.io/${m[1]}`],
    ['greenhouse', /boards\.greenhouse\.io\/([A-Za-z0-9_-]+)/, (m) => `https://job-boards.greenhouse.io/${m[1]}`],
    ['lever', /jobs\.(eu\.)?lever\.co\/([A-Za-z0-9_.-]+)/, (m) => `https://jobs.${m[1] ?? ''}lever.co/${m[2]}`],
    ['ashby', /jobs\.ashbyhq\.com\/([A-Za-z0-9_.%-]+)/, (m) => `https://jobs.ashbyhq.com/${m[1]}`],
    ['workday', /([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([A-Za-z0-9_-]+)/, (m) => `https://${m[1]}.${m[2]}.myworkdayjobs.com/${m[3]}`],
    ['icims', /([a-z0-9-]+)\.icims\.com\/jobs/, (m) => `https://${m[1]}.icims.com/jobs/search?ss=1`],
  ];
  for (const [ats, re, toUrl] of patterns) {
    const m = html.match(re);
    if (!m) continue;
    const boardUrl = toUrl(m);
    if (ats === 'greenhouse' && ['embed', 'v1'].includes(boardUrl.split('/').pop()!)) continue;
    const d = detectAts(boardUrl);
    if (d) return { atsType: ats, boardToken: d.boardToken, boardUrl };
  }
  return null;
}

export interface DetectedCompany {
  careersUrl: string;
  atsType: AdapterKey;
  boardToken: string | null;
  suggestedName: string | null;
  detectedFrom: 'url' | 'page' | 'none';
  message: string;
}

/**
 * Detect a company's ATS from its careers URL: first from the URL itself, otherwise by loading the
 * page and looking for an embedded/linked ATS board. Unknown → generic.
 */
export async function detectCompany(rawUrl: string, http: HttpClient, signal?: AbortSignal): Promise<DetectedCompany> {
  const n = normalizeUrl(rawUrl);
  if (!n.ok) throw new Error(n.reason);
  const url = n.url;
  if (isWttjListingPage(url)) throw new Error('This is a Welcome to the Jungle list page, not a company careers site. Import your matches with Collect → Welcome to the Jungle matches instead.');
  const fromUrl = detectAts(url);
  if (fromUrl) {
    const token = fromUrl.ats === 'workday' ? fromUrl.boardToken.split('/')[0] : fromUrl.ats === 'icims' ? icimsCompanyToken(fromUrl.boardToken) : fromUrl.boardToken;
    return {
      careersUrl: url,
      atsType: fromUrl.ats,
      boardToken: fromUrl.boardToken,
      suggestedName: prettifyToken(token),
      detectedFrom: 'url',
      message: `Detected ${ADAPTERS[fromUrl.ats].label} board "${fromUrl.boardToken}" from the URL.`,
    };
  }
  let html = '';
  let finalUrl = url;
  try {
    const res = await http.getText(url, { signal });
    html = res.text;
    finalUrl = res.url;
  } catch (e) {
    return {
      careersUrl: url,
      atsType: 'generic',
      boardToken: null,
      suggestedName: prettifyToken(new URL(url).hostname.replace(/^www\.|^careers\.|^jobs\./g, '').split('.')[0]),
      detectedFrom: 'none',
      message: `Couldn't load the page (${(e as Error).message}). Saved as generic.`,
    };
  }
  // The careers URL may redirect straight to an ATS board.
  const redirected = detectAts(finalUrl);
  const embedded = redirected
    ? { atsType: redirected.ats as AdapterKey, boardToken: redirected.boardToken, boardUrl: finalUrl }
    : detectEmbeddedAts(html);
  const name = siteName(html) ?? prettifyToken(new URL(url).hostname.replace(/^www\.|^careers\.|^jobs\./g, '').split('.')[0]);
  if (embedded) {
    return {
      careersUrl: embedded.boardUrl,
      atsType: embedded.atsType,
      boardToken: embedded.boardToken,
      suggestedName: name,
      detectedFrom: 'page',
      message: `Found ${/^[AEIOU]/.test(ADAPTERS[embedded.atsType].label) ? "an" : "a"} ${ADAPTERS[embedded.atsType].label} board ("${embedded.boardToken}") on the page — using its API.`,
    };
  }
  return { careersUrl: url, atsType: 'generic', boardToken: null, suggestedName: name, detectedFrom: 'none', message: 'Unknown ATS → generic (JSON-LD / page links).' };
}
