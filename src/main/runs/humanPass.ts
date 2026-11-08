import { screen, type BrowserWindow, type Rectangle } from 'electron';
import type { HumanPassJob, HumanPassSlot, HumanPassState } from '@shared/sites';
import { PASS_WINDOWS_DEFAULT, PASS_WINDOWS_MAX } from '@shared/sites';
import { appEvents } from '../events';
import { redactSecrets } from '../redact';
import { getJobForAnalysis, listHumanQueue, markClosed } from '../repos/analysis';
import { clearBlockedHost, readPage } from '../analysis/fetch';
import { saveFetchedPage } from '../analysis/pipeline';
import { openSiteWindow, pendingRequests, snapshotPage } from '../net/browser';
import { analyzeState, resumeAnalyze } from './analyze';

/**
 * The human pass: pages that asked for a person (bot check / CAPTCHA, sign-in) open in visible
 * windows on the shared site session, several side by side. The user gets through the check or
 * signs in (or signs up) in each, the app reads the posting as soon as it shows and that window
 * moves on to the next link by itself. Until a site has been passed once, only one window works
 * on it (one check / sign-in instead of one per window); after that its links spread over all
 * windows. Afterwards the analysis run that was waiting for them is resumed.
 */

const POLL_MS = 1_000;
/** Text must stay the same this long (and the network be idle) before it's taken as the posting. */
const STABLE_MS = 2_000;
/** …or this long even if some request never ends (analytics, long-polling). */
const STABLE_ANYWAY_MS = 6_000;
const CHECK_HINT = 'Pass the check on the page (tick the box / solve the puzzle) — it can take a few seconds to appear.';
const LOGIN_PATH = /\/(?:log-?in|sign-?in|sign-?up|signup|register|authn?|oauth|sso)(?:[/_?.-]|$)/i;
/** Below this width the pages are zoomed out a little so the check box stays in view. */
const ZOOM_BELOW_WIDTH = 1_100;

type ItemOutcome = 'read' | 'closed' | 'skipped' | 'stopped';

interface Worker {
  slot: HumanPassSlot;
  win: BrowserWindow;
  skip: (() => void) | null;
}

const idle = (): HumanPassState => ({ active: false, total: 0, finished: 0, read: 0, closed: 0, skipped: 0, slots: [], resumedRunId: null });

let state: HumanPassState = idle();
let workers: Worker[] = [];
let pending: HumanPassJob[] = [];
/** Sites a posting was read from in this pass: their check / sign-in is done. */
const passedHosts = new Set<string>();
let windowCount = PASS_WINDOWS_DEFAULT;
let stopRequested = false;

function emit(): void {
  state.slots = workers.map((w) => ({ ...w.slot }));
  for (const w of workers) setTitle(w);
  appEvents.emit('sites:pass', { ...state });
}

export function humanPassState(): HumanPassState {
  return { ...state, slots: state.slots.map((s) => ({ ...s })) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setHint(w: Worker, hint: string | null): void {
  if (w.slot.hint === hint) return;
  w.slot.hint = hint;
  emit();
}

function setTitle(w: Worker): void {
  if (w.win.isDestroyed()) return;
  const job = w.slot.current;
  const what = !job ? 'waiting' : job.block === 'login' ? `${job.host} — sign in (or create an account)` : `${job.host} — pass the check`;
  w.win.setTitle(`Job Matcher — window ${w.slot.window} · ${state.finished} of ${state.total} done · ${what}; the next link opens by itself`);
}

/** Grid positions for `n` windows on the primary screen's work area. */
function tile(n: number): Rectangle[] {
  const area = screen.getPrimaryDisplay().workArea;
  const cols = n <= 1 ? 1 : n <= 4 ? 2 : 3;
  const rows = Math.ceil(n / cols);
  const width = Math.floor(area.width / cols);
  const height = Math.floor(area.height / rows);
  return Array.from({ length: n }, (_, i) => ({ x: area.x + (i % cols) * width, y: area.y + Math.floor(i / cols) * height, width, height }));
}

/**
 * The next link for a free window: one from a site already passed, or from a site no other window
 * is on (so a site's check / sign-in is done once, not in every window).
 */
function takeNext(): HumanPassJob | null {
  const busy = new Set(workers.map((w) => w.slot.current?.host).filter((h): h is string => !!h && !passedHosts.has(h)));
  const i = pending.findIndex((j) => passedHosts.has(j.host) || !busy.has(j.host));
  return i < 0 ? null : pending.splice(i, 1)[0];
}

const waitingPage = (text: string) =>
  `data:text/html;charset=utf-8,${encodeURIComponent(
    `<!doctype html><title>Waiting</title><body style="font:15px system-ui;color:#475569;display:grid;place-items:center;height:90vh;margin:0;text-align:center"><p>${text}</p>`,
  )}`;

/** Load one job page and wait until its posting can be read, the user skips it, or the pass stops. */
async function passOne(w: Worker, job: HumanPassJob): Promise<ItemOutcome> {
  const { win } = w;
  const wc = win.webContents;
  let status: number | null = null;
  let loggedIn = false;
  // Until the new page commits, the window still shows the previous page.
  let navigated = false;
  const onNavigate = (_e: unknown, _url: string, code: number) => {
    navigated = true;
    if (code) status = code;
  };
  const onInPage = () => {
    navigated = true;
  };
  wc.on('did-navigate', onNavigate);
  wc.on('did-navigate-in-page', onInPage);
  let skipped = false;
  w.skip = () => {
    skipped = true;
  };
  try {
    void wc.loadURL(job.url).catch(() => undefined);
    let lastLen = -1;
    let stableSince = Date.now();
    for (;;) {
      await sleep(POLL_MS);
      if (stopRequested || win.isDestroyed()) return 'stopped';
      if (skipped) return 'skipped';
      if (!navigated) continue;
      const page = await snapshotPage(wc, status).catch(() => null);
      if (!page) continue;

      // On a sign-in / sign-up page: wait; once the user is through, open the posting again
      // (sites often land on their dashboard after signing in).
      let path = '';
      try {
        path = new URL(page.url).pathname;
      } catch {
        // about:blank and the like
      }
      if (LOGIN_PATH.test(path)) {
        loggedIn = true;
        setHint(w, 'Sign in, or create an account — the posting opens again after that.');
        lastLen = -1;
        continue;
      }
      if (loggedIn) {
        loggedIn = false;
        status = null;
        navigated = false;
        void wc.loadURL(job.url).catch(() => undefined);
        continue;
      }

      if (page.challenge) setHint(w, CHECK_HINT);
      const len = page.html.length;
      if (len !== lastLen) {
        lastLen = len;
        stableSince = Date.now();
        continue;
      }
      const stableFor = Date.now() - stableSince;
      if (stableFor < STABLE_MS || (pendingRequests(win) > 0 && stableFor < STABLE_ANYWAY_MS)) continue;

      const read = await readPage(job.url, page, 'browser', new Date());
      if (read.kind !== 'weak') {
        const res = read.result;
        if (res.kind === 'closed') {
          markClosed(job.jobId, res.reason);
          return 'closed';
        }
        if (res.kind === 'text') {
          const current = getJobForAnalysis(job.jobId);
          if (current) saveFetchedPage(job.jobId, current.sourceKey, res);
          return 'read';
        }
        continue;
      }
      setHint(
        w,
        read.block === 'login'
          ? 'This page wants you to sign in (or create an account).'
          : read.block === 'bot_check' || page.challenge
            ? CHECK_HINT
            : "Waiting for the posting to show — if it never does, click Skip in Job Matcher (you can still paste it by hand).",
      );
    }
  } finally {
    w.skip = null;
    if (!wc.isDestroyed()) {
      wc.off('did-navigate', onNavigate);
      wc.off('did-navigate-in-page', onInPage);
    }
  }
}

/** One window: takes links until none are left, the window is closed or the pass stops. */
async function work(w: Worker): Promise<void> {
  let waitingShown = false;
  try {
    while (!stopRequested && !w.win.isDestroyed()) {
      const job = takeNext();
      if (!job) {
        if (!pending.length) break;
        // The links left are on a site another window is still passing.
        if (!waitingShown) {
          waitingShown = true;
          w.slot.current = null;
          setHint(w, 'Waiting — another window is on the same site; once its check or sign-in is done, this one carries on.');
          void w.win.loadURL(waitingPage('Waiting for another window to get through this site’s check or sign-in…')).catch(() => undefined);
        }
        await sleep(POLL_MS);
        continue;
      }
      waitingShown = false;
      w.slot.current = job;
      w.slot.hint = null;
      emit();
      const outcome = await passOne(w, job);
      w.slot.current = null;
      if (outcome === 'stopped') {
        // This window was closed: another one picks the link up.
        if (!stopRequested) pending.unshift(job);
        break;
      }
      state.finished++;
      if (outcome === 'read' || outcome === 'closed') {
        if (outcome === 'read') state.read++;
        else state.closed++;
        passedHosts.add(job.host);
        clearBlockedHost(job.host);
        appEvents.emit('jobs:updated', { count: 1 });
      } else {
        state.skipped++;
      }
      emit();
    }
  } catch (e) {
    console.error(`[human pass] ${redactSecrets((e as Error)?.stack ?? String(e))}`);
  } finally {
    if (!w.win.isDestroyed()) w.win.destroy();
    workers = workers.filter((x) => x !== w);
    if (workers.length) emit();
    else finish();
  }
}

function finish(): void {
  state.active = false;
  pending = [];
  // The analysis that was waiting for these descriptions carries on.
  if (state.read > 0) {
    try {
      const { active, last } = analyzeState();
      if (!active && last && last.remaining > 0) state.resumedRunId = resumeAnalyze(last.runId).runId;
    } catch (e) {
      console.warn(`[human pass] couldn't resume the analysis: ${redactSecrets((e as Error).message)}`);
    }
  }
  emit();
}

/** Open windows (up to the chosen count, one per waiting link at most) and start them working. */
function addWorkers(): void {
  const want = Math.min(windowCount, workers.length + pending.length);
  if (workers.length >= want) return;
  const bounds = tile(want);
  workers.forEach((w, i) => {
    if (!w.win.isDestroyed()) w.win.setBounds(bounds[i]);
  });
  const used = new Set(workers.map((w) => w.slot.window));
  for (let i = workers.length; i < want; i++) {
    let n = 1;
    while (used.has(n)) n++;
    used.add(n);
    const b = bounds[i];
    const win = openSiteWindow('about:blank', `Job Matcher — window ${n}`, { bounds: b, zoomFactor: b.width < ZOOM_BELOW_WIDTH ? 0.8 : 1 });
    const w: Worker = { slot: { window: n, current: null, hint: null }, win, skip: null };
    workers.push(w);
    void work(w);
  }
}

/**
 * Go through the waiting pages (all of them, or just `jobIds`) in `windows` windows side by side.
 * While a pass runs, more links are added to it.
 */
export function startHumanPass(jobIds: number[] | null, windows = PASS_WINDOWS_DEFAULT): HumanPassState {
  const inPass = new Set([...pending, ...workers.map((w) => w.slot.current)].map((j) => j?.jobId));
  const queue = listHumanQueue(jobIds).filter((j) => !inPass.has(j.jobId));
  if (state.active) {
    pending.push(...queue);
    state.total += queue.length;
    addWorkers();
    workers[0]?.win.focus();
    emit();
    return humanPassState();
  }
  if (!queue.length) throw new Error('No links are waiting for a bot check or sign-in.');
  stopRequested = false;
  passedHosts.clear();
  windowCount = Math.max(1, Math.min(PASS_WINDOWS_MAX, windows));
  pending = queue;
  state = { ...idle(), active: true, total: queue.length };
  addWorkers();
  emit();
  return humanPassState();
}

/** Skip the link a window is on (by job id), or every window's when null. */
export function skipHumanPassItem(jobId: number | null = null): void {
  for (const w of workers) if (jobId == null || w.slot.current?.jobId === jobId) w.skip?.();
}

export function stopHumanPass(): void {
  stopRequested = true;
}
