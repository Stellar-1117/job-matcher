import { join } from 'node:path';
import { app, BrowserWindow, safeStorage, shell } from 'electron';
import { openDb, closeDb } from './db';
import { setSecretCipher } from './repos/keys';
import { seedDatabase } from './seed';
import { failInterruptedParses } from './repos/profiles';
import { markInterruptedRuns, runningRunIds } from './repos/runs';
import { resumeAnalyze, setDefaultRenderer } from './runs/analyze';
import { renderPage } from './net/browser';
import { registerIpc } from './ipc';
import { appEvents } from './events';
import type { IpcEventName } from '@shared/ipc';
import { redactSecrets } from './redact';

const FORWARDED_EVENTS: IpcEventName[] = ['usage:logged', 'resume:updated', 'run:progress', 'analyze:progress', 'jobs:updated'];

/** App windows (not the hidden fetch windows of the analysis fetch ladder), which receive push events. */
const appWindows = new Set<BrowserWindow>();

// Test hook: run against a separate data folder (throwaway DB, no saved keys).
if (process.env.JOB_MATCHER_USER_DATA) app.setPath('userData', process.env.JOB_MATCHER_USER_DATA);

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    title: 'Job Matcher',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => win.show());
  appWindows.add(win);
  win.on('closed', () => {
    appWindows.delete(win);
    // Hidden fetch windows may still be open; they shouldn't keep the app alive.
    if (appWindows.size === 0 && process.platform !== 'darwin') app.quit();
  });

  // External links open in the system browser; the app never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault();
  });

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
  return win;
}

app.whenReady().then(() => {
  setSecretCipher({
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (blob) => safeStorage.decryptString(blob),
  });

  const dbPath = join(app.getPath('userData'), 'jobmatcher.db');
  openDb(dbPath);
  seedDatabase();
  failInterruptedParses();
  // Analyses that were running when the app closed are resumed automatically (§5); collections wait for "Resume".
  const unfinishedAnalysis = runningRunIds('analyze').at(-1);
  markInterruptedRuns();
  setDefaultRenderer(renderPage);
  registerIpc(dbPath);

  for (const name of FORWARDED_EVENTS) {
    appEvents.on(name, (payload) => {
      for (const w of appWindows) if (!w.isDestroyed()) w.webContents.send(`event:${name}`, payload);
    });
  }

  createWindow();
  app.on('activate', () => {
    if (appWindows.size === 0) createWindow();
  });

  if (unfinishedAnalysis != null) {
    try {
      resumeAnalyze(unfinishedAnalysis);
    } catch (e) {
      console.warn(`[analyze] couldn't resume run ${unfinishedAnalysis}: ${redactSecrets((e as Error).message)}`);
    }
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => closeDb());
