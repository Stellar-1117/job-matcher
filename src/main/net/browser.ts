import { BrowserWindow, session } from 'electron';
import { BROWSER_UA } from './http';
import type { RenderedPage } from '../analysis/fetch';

/**
 * Step 3 of the fetch ladder: render a JavaScript-heavy page in a hidden, sandboxed window, wait
 * until the network is idle and the text stops changing, then return the page's HTML.
 *
 * The window uses its own in-memory session (no cookies shared with the app or kept on disk),
 * has no preload / Node access, blocks images, media, fonts, downloads, popups and permission
 * prompts, and is destroyed after each page.
 */

const PARTITION = 'jobmatcher-fetch'; // no "persist:" prefix → in-memory only
const MAX_WINDOWS = 2;
const TIMEOUT_MS = 25_000;
const QUIET_MS = 1_200;
const STABLE_ANYWAY_MS = 4_000;
/** Bot checks (Cloudflare "Just a moment…") usually clear by themselves in a real browser within ~10s. */
const CHALLENGE_TIMEOUT_MS = 45_000;
const CHALLENGE_RELOAD_MS = 5_000;
const MAX_CHALLENGE_RELOADS = 3;
const POLL_MS = 300;

/** Open network requests per webContents, for "network idle". */
const openRequests = new Map<number, Set<number>>();
let configured = false;

function configureSession(): void {
  if (configured) return;
  configured = true;
  const s = session.fromPartition(PARTITION);
  s.setUserAgent(BROWSER_UA);
  s.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
  s.on('will-download', (e) => e.preventDefault());
  s.webRequest.onBeforeRequest((details, cb) => {
    if (details.resourceType === 'image' || details.resourceType === 'media' || details.resourceType === 'font') return cb({ cancel: true });
    if (details.webContentsId != null) openRequests.get(details.webContentsId)?.add(details.id);
    cb({});
  });
  const done = (d: { id: number; webContentsId?: number }) => {
    if (d.webContentsId != null) openRequests.get(d.webContentsId)?.delete(d.id);
  };
  s.webRequest.onCompleted(done);
  s.webRequest.onErrorOccurred(done);
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

/** Text length, and whether the page is a bot-check interstitial (Cloudflare and similar). */
const PAGE_STATE_JS = `(() => {
  const title = document.title || '';
  const challenge = /^(just a moment|attention required|checking your browser|please wait)/i.test(title.trim())
    || !!document.querySelector('#challenge-form, #challenge-running, #cf-challenge-running, script[src*="challenges.cloudflare.com"], [name="cf-turnstile-response"]');
  return { len: document.body ? document.body.innerText.length : 0, challenge };
})()`;

export async function renderPage(url: string, opts: { signal?: AbortSignal } = {}): Promise<RenderedPage> {
  const { signal } = opts;
  if (signal?.aborted) throw abortError();
  configureSession();
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
    for (;;) {
      await sleep(POLL_MS);
      if (signal?.aborted || win.isDestroyed()) throw abortError();
      const { len, challenge } = (await wc.executeJavaScript(PAGE_STATE_JS, true).catch(() => ({ len: 0, challenge: false }))) as { len: number; challenge: boolean };
      const elapsed = Date.now() - started;
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
    return { html: page.html, url: page.url || url, status };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    openRequests.delete(wcId);
    if (!win.isDestroyed()) win.destroy();
    release();
  }
}
