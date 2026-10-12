import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, session } from 'electron';
import { BROWSER_UA } from '../net/http';
import { isWttjMatchesApi, wttjJobUrls, wttjJobUrlsFromJson } from './wttjLinks';

/**
 * Welcome to the Jungle "Matches" (https://www.welcometothejungle.com/en/jobs-matches): the user's
 * personal job matches, only visible when signed in. The user signs in once in a visible window;
 * the session lives in its own persistent partition (separate from the app and from the hidden
 * fetch browser), and the matches page is then read in a hidden window of that partition.
 */

export const WTTJ_PARTITION = 'persist:wttj';
export const WTTJ_MATCHES_URL = 'https://www.welcometothejungle.com/en/jobs-matches';
const SIGN_IN_URL = 'https://www.welcometothejungle.com/en/authenticate/signin?redirect=%2Fen%2Fjobs-matches';

export class WttjSignInRequired extends Error {
  override name = 'WttjSignInRequired';
  constructor() {
    super('Not signed in to Welcome to the Jungle. Click "Sign in" first.');
  }
}

let configured = false;
function wttjSession(): Electron.Session {
  const s = session.fromPartition(WTTJ_PARTITION);
  if (!configured) {
    configured = true;
    // A regular Chrome user agent: some sign-in providers refuse embedded browsers.
    s.setUserAgent(BROWSER_UA);
    s.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
    s.on('will-download', (e) => e.preventDefault());
  }
  return s;
}

const webPreferences = { partition: WTTJ_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false };

const isSignInPath = (url: string) => /\/authenticate\b|\/signin\b|\/login\b/i.test(url);
const isMatchesPath = (url: string) => {
  try {
    return /\/jobs-matches\/?$/.test(new URL(url).pathname);
  } catch {
    return false;
  }
};

/**
 * Open a visible sign-in window. Resolves when the user lands on their matches page (signed in;
 * the window closes itself) or closes the window.
 */
export function openWttjSignIn(): Promise<{ signedIn: boolean }> {
  wttjSession();
  const parent = BrowserWindow.getFocusedWindow() ?? undefined;
  const win = new BrowserWindow({ width: 520, height: 760, parent, title: 'Sign in to Welcome to the Jungle', autoHideMenuBar: true, webPreferences });
  // Google / Apple sign-in may open a popup: allow it in the same partition.
  win.webContents.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions: { parent: win, autoHideMenuBar: true, webPreferences } }));
  return new Promise((resolve) => {
    let signedIn = false;
    const check = (url: string) => {
      if (isMatchesPath(url) && !isSignInPath(url)) {
        signedIn = true;
        setTimeout(() => !win.isDestroyed() && win.close(), 800);
      }
    };
    win.webContents.on('did-navigate', (_e, url) => check(url));
    win.webContents.on('did-navigate-in-page', (_e, url) => check(url));
    win.on('closed', () => resolve({ signedIn }));
    void win.loadURL(SIGN_IN_URL).catch(() => undefined);
  });
}

export async function signOutWttj(): Promise<void> {
  await wttjSession().clearStorageData();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One round on the matches page: return every link href, then scroll (the page and any inner
 * scroll area) and press a "show more" button if there is one, to load more matches.
 */
const ROUND_JS = `(() => {
  const hrefs = [...document.querySelectorAll('a[href]')].map((a) => a.href);
  window.scrollTo(0, document.documentElement.scrollHeight);
  for (const el of document.querySelectorAll('main div, [role="main"] div, ul, section')) {
    if (el.scrollHeight > el.clientHeight + 40 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) el.scrollTop = el.scrollHeight;
  }
  const more = [...document.querySelectorAll('button, a')].find(
    (b) => !b.disabled && /^(show|load|see|view) more|^more (jobs|matches)|voir plus|afficher plus|charger plus/i.test((b.textContent || '').trim()),
  );
  if (more) more.click();
  return { hrefs, url: location.href, clickedMore: !!more };
})()`;

/** Go to the next page of a paginated list, if there is one. */
const NEXT_PAGE_JS = `(() => {
  const next = document.querySelector('a[rel="next"], a[aria-label*="next" i], button[aria-label*="next" i]');
  if (!next || next.disabled || next.getAttribute('aria-disabled') === 'true') return false;
  next.click();
  return true;
})()`;

const MAX_ROUNDS = 150;
const MAX_LINKS = 2000;
const ROUND_MS = 1500;
const PAGE_TIMEOUT_MS = 30_000;

export class WttjNoJobsFound extends Error {
  override name = 'WttjNoJobsFound';
}

/** What the importer saw, written next to the app's data when it finds no jobs (to fix the reader). */
interface WttjDiagnostics {
  at: string;
  finalUrl: string;
  title: string;
  links: number;
  sampleLinks: string[];
  apiCalls: { url: string; status: number; jobs: number }[];
  textStart: string;
}

function writeDiagnostics(d: WttjDiagnostics): string {
  const file = join(app.getPath('userData'), 'wttj-import-debug.json');
  try {
    writeFileSync(file, JSON.stringify(d, null, 2));
  } catch {
    // diagnostics are best-effort
  }
  return file;
}

/**
 * Read the job links of the signed-in user's matches. Jobs come from the page's links and from the
 * site's JSON API responses (captured as the page loads). Throws WttjSignInRequired when the site
 * sends us to sign in, WttjNoJobsFound when signed in but nothing was recognised.
 */
export async function readWttjMatches(opts: { signal?: AbortSignal } = {}): Promise<string[]> {
  wttjSession();
  const win = new BrowserWindow({ show: false, width: 1280, height: 1000, webPreferences: { ...webPreferences, images: false, backgroundThrottling: false } });
  const wc = win.webContents;
  wc.setAudioMuted(true);
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  const onAbort = () => !win.isDestroyed() && win.destroy();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const alive = () => {
    if (opts.signal?.aborted || win.isDestroyed()) throw new Error('Cancelled');
  };

  const found = new Set<string>();
  const apiCalls: WttjDiagnostics['apiCalls'] = [];
  // Capture the site's API responses: the matches list is loaded as JSON.
  const pending = new Map<string, { url: string; status: number }>();
  try {
    wc.debugger.attach('1.3');
    wc.debugger.on('message', (_e, method, params) => {
      if (method === 'Network.responseReceived' && isWttjMatchesApi(params.response?.url ?? '')) {
        pending.set(params.requestId, { url: String(params.response.url).split('?')[0], status: params.response.status });
      } else if (method === 'Network.loadingFinished' && pending.has(params.requestId)) {
        const call = pending.get(params.requestId)!;
        pending.delete(params.requestId);
        void wc.debugger
          .sendCommand('Network.getResponseBody', { requestId: params.requestId })
          .then((r: { body: string; base64Encoded: boolean }) => {
            const body = r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body;
            const urls = wttjJobUrlsFromJson(JSON.parse(body));
            for (const u of urls) found.add(u);
            apiCalls.push({ ...call, jobs: urls.length });
          })
          .catch(() => apiCalls.push({ ...call, jobs: -1 }));
      }
    });
    void wc.debugger.sendCommand('Network.enable', { maxTotalBufferSize: 50_000_000, maxResourceBufferSize: 10_000_000 });
  } catch {
    // Without the debugger we still read the page's links.
  }

  try {
    await wc.loadURL(WTTJ_MATCHES_URL).catch((e: Error) => {
      if (!/ERR_ABORTED|\(-3\)/.test(e.message)) throw new Error(`Couldn't open Welcome to the Jungle (${e.message})`);
    });

    const addLinks = (hrefs: string[]) => {
      for (const u of wttjJobUrls(hrefs)) found.add(u);
    };
    // Wait until the matches render (or the site sends us to sign in).
    const deadline = Date.now() + PAGE_TIMEOUT_MS;
    while (Date.now() < deadline && !found.size) {
      await sleep(700);
      alive();
      if (isSignInPath(wc.getURL())) throw new WttjSignInRequired();
      addLinks((await wc.executeJavaScript(`[...document.querySelectorAll('a[href]')].map((a) => a.href)`, true).catch(() => [])) as string[]);
    }

    // Load everything: scroll / "show more" / next page until nothing new turns up.
    let idle = 0;
    for (let round = 0; found.size && round < MAX_ROUNDS && found.size < MAX_LINKS; round++) {
      alive();
      const r = (await wc.executeJavaScript(ROUND_JS, true)) as { hrefs: string[]; url: string };
      if (isSignInPath(r.url)) throw new WttjSignInRequired();
      const before = found.size;
      addLinks(r.hrefs);
      await sleep(ROUND_MS);
      idle = found.size > before ? 0 : idle + 1;
      if (idle === 2) {
        const moved = (await wc.executeJavaScript(NEXT_PAGE_JS, true).catch(() => false)) as boolean;
        if (moved) idle = 0;
      }
      if (idle >= 4) break;
    }

    if (!found.size) {
      const page = (await wc
        .executeJavaScript(
          `({ title: document.title, text: document.body ? document.body.innerText.slice(0, 600) : '', links: [...document.querySelectorAll('a[href]')].map((a) => a.href) })`,
          true,
        )
        .catch(() => ({ title: '', text: '', links: [] }))) as { title: string; text: string; links: string[] };
      const file = writeDiagnostics({
        at: new Date().toISOString(),
        finalUrl: wc.getURL().split('?')[0],
        title: page.title,
        links: page.links.length,
        sampleLinks: [...new Set(page.links.filter((l) => /welcometothejungle\.com/.test(l)).map((l) => l.split('?')[0]))].slice(0, 60),
        apiCalls,
        textStart: page.text,
      });
      throw new WttjNoJobsFound(`Signed in, but no jobs were recognised on your Matches page. Details saved to ${file} — send that file to have the reader fixed.`);
    }
    return [...found];
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
    if (!win.isDestroyed()) {
      try {
        wc.debugger.detach();
      } catch {
        // not attached
      }
      win.destroy();
    }
  }
}
