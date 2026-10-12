import type { JobProfileAnalysis } from './jobs';

/** One job from the user's Welcome to the Jungle matches, as of an import. */
export interface WttjMatch {
  url: string;
  jobId: number | null;
  /** new = saved by this import; already_saved = the app had it before. */
  status: 'new' | 'already_saved';
  /** Current job details (filled in when the state is read; the job may have been deleted since). */
  title: string | null;
  companyName: string | null;
  analyses: JobProfileAnalysis[];
}

export interface WttjImport {
  importedAt: string;
  matches: WttjMatch[];
}

export interface WttjState {
  lastImport: WttjImport | null;
  importing: boolean;
}

/**
 * Bookmarklet for the user's own browser (Google sign-in is refused inside embedded browsers):
 * on the WTTJ Matches page it scrolls / presses "show more" until no new jobs appear, then copies
 * every job link to the clipboard (or shows them selected for Ctrl+C) to paste into the app.
 */
export const WTTJ_BOOKMARKLET_SOURCE = String.raw`(async () => {
  const re = /^https:\/\/(?:www\.)?welcometothejungle\.com\/[a-z]{2}(?:-[a-z]{2})?\/companies\/[^/]+\/jobs\/[^/?#]+/;
  const found = new Set();
  const grab = () => document.querySelectorAll('a[href]').forEach((a) => { const m = a.href.match(re); if (m) found.add(m[0]); });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let idle = 0;
  for (let i = 0; i < 80 && idle < 3; i++) {
    const before = found.size;
    grab();
    window.scrollTo(0, document.documentElement.scrollHeight);
    const more = [...document.querySelectorAll('button')].find((b) => /^(show|load|see) more|voir plus|afficher plus/i.test(b.textContent.trim()));
    if (more) more.click();
    await sleep(1200);
    grab();
    idle = found.size > before ? 0 : idle + 1;
  }
  const text = [...found].join('\n');
  let copied = false;
  try { await navigator.clipboard.writeText(text); copied = true; } catch (e) { copied = false; }
  if (!copied && found.size) {
    const box = document.createElement('textarea');
    box.value = text;
    box.style.cssText = 'position:fixed;top:10%;left:20%;width:60%;height:60%;z-index:2147483647;font:12px monospace;padding:12px;border:3px solid #4f46e5;background:#fff;color:#000';
    document.body.appendChild(box);
    box.focus();
    box.select();
  }
  alert(found.size + ' job links ' + (copied ? 'copied. Paste them into Job Matcher (Collect, Welcome to the Jungle matches).' : found.size ? 'found and selected: press Ctrl+C, then paste them into Job Matcher.' : 'found. Open your Matches page first.'));
})();`;

/** The bookmark's URL (paste it as the URL of a new bookmark). */
export const WTTJ_BOOKMARKLET = `javascript:${encodeURIComponent(WTTJ_BOOKMARKLET_SOURCE.replace(/\n\s*/g, ' '))}`;
