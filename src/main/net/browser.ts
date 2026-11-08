import { BrowserWindow, session, type Rectangle, type Session, type WebContents } from 'electron';
import type { SiteSession } from '@shared/sites';
import { BROWSER_UA } from './http';
import type { RenderedPage } from '../analysis/fetch';

/**
 * Step 3 of the fetch ladder: render a JavaScript-heavy page in a hidden, sandboxed window, wait
 * until the network is idle and the text stops changing, then return the page's HTML.
 *
 * The window has no preload / Node access, blocks images, media, fonts, downloads, popups and
 * permission prompts, and is destroyed after each page. Its session (separate from the app's) is
 * kept on disk and shared with the visible site windows, so a sign-in or a bot check the user
 * passed there carries over to the hidden fetches and to later runs.
 */

const PARTITION = 'persist:jobmatcher-sites';
const MAX_WINDOWS = 2;
const TIMEOUT_MS = 25_000;
const QUIET_MS = 1_200;
const STABLE_ANYWAY_MS = 4_000;
/** Bot checks (Cloudflare "Just a moment…") usually clear by themselves in a real browser within ~10s. */
const CHALLENGE_TIMEOUT_MS = 45_000;
const CHALLENGE_RELOAD_MS = 5_000;
const MAX_CHALLENGE_RELOADS = 3;
const POLL_MS = 300;

/** Open network requests per hidden webContents, for "network idle". */
const openRequests = new Map<number, Set<number>>();
/** The same for visible site windows (their images aren't blocked). */
const visibleRequests = new Map<number, Set<number>>();
let configured = false;

/** The shared site session, configured on first use. */
export function siteSession(): Session {
  const s = session.fromPartition(PARTITION);
  if (configured) return s;
  configured = true;
  s.setUserAgent(BROWSER_UA);
  s.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
  s.on('will-download', (e) => e.preventDefault());
  s.webRequest.onBeforeRequest((details, cb) => {
    const hidden = details.webContentsId != null ? openRequests.get(details.webContentsId) : undefined;
    // Only the hidden fetch windows skip images and fonts; visible windows show CAPTCHAs and sign-in pages.
    if (hidden && (details.resourceType === 'image' || details.resourceType === 'media' || details.resourceType === 'font')) return cb({ cancel: true });
    hidden?.add(details.id);
    if (details.webContentsId != null) visibleRequests.get(details.webContentsId)?.add(details.id);
    cb({});
  });
  const done = (d: { id: number; webContentsId?: number }) => {
    if (d.webContentsId == null) return;
    openRequests.get(d.webContentsId)?.delete(d.id);
    visibleRequests.get(d.webContentsId)?.delete(d.id);
  };
  s.webRequest.onCompleted(done);
  s.webRequest.onErrorOccurred(done);
  return s;
}

let running = 0;
const waiting: (() => void)[] = [];
async function acquire(): Promise<() => void> {
  if (running >= MAX_WINDOWS) await new Promise<void>((r) => waiting.push(r));
  running++;
  return () => {
    running--;
    waiting.shift()?.();
  };
}

function abortError(): Error {
  const e = new Error('Cancelled');
  e.name = 'AbortError';
  return e;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Text length, and whether the page is a bot-check gate: a Cloudflare interstitial, or a
 * "confirm you're human" dialog over the page (JobDiva). A CAPTCHA inside an ordinary form doesn't count.
 */
const PAGE_STATE_JS = `(() => {
  const title = document.title || '';
  const challenge = /^(just a moment|attention required|checking your browser|please wait)/i.test(title.trim())
    || !!document.querySelector('#challenge-form, #challenge-running, #cf-challenge-running, [role="dialog"][aria-label="Security check"]');
  return { len: document.body ? document.body.innerText.length : 0, challenge };
})()`;

/** The page a window currently shows, with whether it is a bot check. */
export async function snapshotPage(wc: WebContents, status: number | null): Promise<RenderedPage> {
  const page = (await wc.executeJavaScript(`({ html: document.documentElement.outerHTML, url: location.href, state: ${PAGE_STATE_JS} })`, true)) as {
    html: string;
    url: string;
    state: { challenge: boolean };
  };
  return { html: page.html, url: page.url, status, challenge: page.state.challenge };
}

export async function renderPage(url: string, opts: { signal?: AbortSignal } = {}): Promise<RenderedPage> {
  const { signal } = opts;
  if (signal?.aborted) throw abortError();
  siteSession();
  const release = await acquire();
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 1000,
    webPreferences: {
      partition: PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      images: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  const wc = win.webContents;
  const wcId = wc.id;
  const requests = new Set<number>();
  openRequests.set(wcId, requests);
  wc.setAudioMuted(true);
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  let status: number | null = null;
  wc.on('did-navigate', (_e, _url, code) => {
    if (code) status = code;
  });
  const onAbort = () => {
    if (!win.isDestroyed()) win.destroy();
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    try {
      await wc.loadURL(url);
    } catch (e) {
      if (signal?.aborted) throw abortError();
      // ERR_ABORTED happens when the page immediately navigates elsewhere (client-side redirect).
      if (!/ERR_ABORTED|\(-3\)/.test(String((e as Error).message))) throw new Error(`couldn't load the page (${(e as Error).message})`);
    }
    const started = Date.now();
    let lastLen = -1;
    let stableSince = Date.now();
    let challengeSince: number | null = null;
    let reloads = 0;
    let challenged = false;
    for (;;) {
      await sleep(POLL_MS);
      if (signal?.aborted || win.isDestroyed()) throw abortError();
      const { len, challenge } = (await wc.executeJavaScript(PAGE_STATE_JS, true).catch(() => ({ len: 0, challenge: false }))) as { len: number; challenge: boolean };
      const elapsed = Date.now() - started;
      challenged = challenge;
      if (challenge) {
        // Keep waiting while the bot check runs. Cloudflare challenges the first request of a fresh
        // session; once its cookie is set, loading the page again usually goes straight through.
        if (elapsed >= CHALLENGE_TIMEOUT_MS) break;
        challengeSince ??= Date.now();
        if (reloads < MAX_CHALLENGE_RELOADS && Date.now() - challengeSince >= CHALLENGE_RELOAD_MS * (reloads + 1)) {
          reloads++;
          void wc.loadURL(wc.getURL()).catch(() => undefined);
        }
        stableSince = Date.now();
        lastLen = -1;
        continue;
      }
      if (elapsed >= TIMEOUT_MS) break;
      if (len !== lastLen) {
        lastLen = len;
        stableSince = Date.now();
      }
      const stableFor = Date.now() - stableSince;
      // Network idle + stable text; or text stable for a while even if some request never ends (analytics, long-polling).
      if (len > 0 && ((requests.size === 0 && stableFor >= QUIET_MS) || stableFor >= STABLE_ANYWAY_MS)) break;
    }
    if (win.isDestroyed()) throw abortError();
    const page = (await wc.executeJavaScript('({ html: document.documentElement.outerHTML, url: location.href })', true)) as { html: string; url: string };
    return { html: page.html, url: page.url || url, status, challenge: challenged };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    openRequests.delete(wcId);
    if (!win.isDestroyed()) win.destroy();
    release();
  }
}

/**
 * A visible window on the site session, for signing in / signing up and for the human pass. Popups
 * (e.g. "Sign in with Google") open as more windows on the same session.
 */
export function openSiteWindow(url: string, title: string, opts: { bounds?: Rectangle; zoomFactor?: number } = {}): BrowserWindow {
  siteSession();
  const webPreferences = { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false };
  const win = new BrowserWindow({
    ...(opts.bounds ?? { width: 1200, height: 900 }),
    title,
    autoHideMenuBar: true,
    webPreferences: { ...webPreferences, zoomFactor: opts.zoomFactor ?? 1 },
  });
  win.webContents.setWindowOpenHandler(({ url: target }) =>
    /^https?:\/\//.test(target) ? { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences } } : { action: 'deny' },
  );
  // Keep our title (the progress of the human pass) instead of the page's.
  win.on('page-title-updated', (e) => e.preventDefault());
  const wcId = win.webContents.id;
  visibleRequests.set(wcId, new Set());
  win.on('closed', () => visibleRequests.delete(wcId));
  void win.loadURL(url).catch(() => undefined);
  return win;
}

/** Network requests still open in a visible site window (0 = idle). */
export function pendingRequests(win: BrowserWindow): number {
  return win.isDestroyed() ? 0 : (visibleRequests.get(win.webContents.id)?.size ?? 0);
}

/** "jobs.ziprecruiter.com" → "ziprecruiter.com" (two labels, three for "co.uk"-style suffixes). */
export function registrableDomain(host: string): string {
  const parts = host.replace(/^\./, '').toLowerCase().split('.');
  const n = parts.length >= 3 && /^(co|com|org|net|ac|gov)$/.test(parts[parts.length - 2]) && parts[parts.length - 1].length === 2 ? 3 : 2;
  return parts.slice(-n).join('.');
}

/** Sites with saved cookies (sign-ins, passed bot checks). */
export async function listSiteSessions(): Promise<SiteSession[]> {
  const cookies = await siteSession().cookies.get({});
  const byDomain = new Map<string, SiteSession>();
  for (const c of cookies) {
    if (!c.domain) continue;
    const domain = registrableDomain(c.domain);
    const s = byDomain.get(domain) ?? { domain, cookies: 0, expiresAt: null };
    s.cookies++;
    if (c.expirationDate) {
      const iso = new Date(c.expirationDate * 1000).toISOString();
      if (!s.expiresAt || iso > s.expiresAt) s.expiresAt = iso;
    }
    byDomain.set(domain, s);
  }
  return [...byDomain.values()].sort((a, b) => a.domain.localeCompare(b.domain));
}

/** Forget one site's cookies and storage (signs out there), or everything when `domain` is null. */
export async function clearSiteSession(domain: string | null): Promise<void> {
  const s = siteSession();
  if (!domain) {
    await s.clearStorageData();
    return;
  }
  const cookies = await s.cookies.get({});
  const hosts = new Set<string>([domain, `www.${domain}`]);
  for (const c of cookies) {
    if (!c.domain || registrableDomain(c.domain) !== domain) continue;
    const host = c.domain.replace(/^\./, '');
    hosts.add(host);
    await s.cookies.remove(`http${c.secure ? 's' : ''}://${host}${c.path ?? '/'}`, c.name).catch(() => undefined);
  }
  for (const h of hosts) await s.clearStorageData({ origin: `https://${h}` }).catch(() => undefined);
}
