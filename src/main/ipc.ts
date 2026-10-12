import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ipcContract, type IpcChannel, type IpcOutput, type IpcParsedInput, type IpcResult } from '@shared/ipc';
import { getSettings, updateSettings } from './repos/settings';
import { deleteKey, getProviderCredentials, listKeys, setKey } from './repos/keys';
import { deleteModel, listModels, upsertModel } from './repos/models';
import { listRoutes, upsertRoute } from './repos/routes';
import { createPromptVersion, listPrompts, setActivePrompt, updatePromptNotes } from './repos/prompts';
import { addLinks, deleteJobs, getJobItem, listJobs } from './repos/jobs';
import { listNeedsPaste, listRunAnalyses, listUnreadableDomains, resetAllUnreadable, resetFetch, savePastedText } from './repos/analysis';
import { analyzeState, cancelAnalyze, estimate, resumeAnalyze, startAnalyze } from './runs/analyze';
import { appEvents } from './events';
import { importWttjLinks, importWttjMatches, wttjState } from './runs/wttj';
import { openWttjSignIn, signOutWttj } from './sources/wttj';
import { exportRows, getResultDetail, listResults, markExported, markOpened, setFeedback, setStatuses } from './repos/results';
import { buildExport, exportFileName } from '@shared/results';
import {
  createProfile,
  createResume,
  deleteProfile,
  deleteResume,
  getProfile,
  getResume,
  getResumeFile,
  listProfiles,
  renameProfile,
  revertStructured,
  savePreferences,
  saveStructured,
  setActiveResume,
} from './repos/profiles';
import { extractResumeText, normalizeText } from './resume/extract';
import { addCompany, deleteCompany, getCompanyRef, listCompanies, updateCompany } from './repos/companies';
import { adapterFor as sourceAdapterFor, detectCompany } from './sources';
import { getHttp } from './net/http';
import { ATS_SOURCE_KEYS } from '@shared/collect';
import { cancelRun, collectState, enrichAtsJobs, resumeCollect, startCollect } from './runs/collect';
import { cleanParsed, parseResume } from './resume/parse';
import { adapterFor, runTask } from './llm';
import { SAMPLE_VARS } from './llm/samples';
import { redactSecrets } from './redact';
import { usageSummary } from './repos/usage';

type Handlers = { [C in IpcChannel]: (input: IpcParsedInput<C>) => Promise<IpcOutput<C>> | IpcOutput<C> };


export function registerIpc(dbPath: string): void {
  const handlers: Handlers = {
    'app:info': () => ({ version: app.getVersion(), dbPath, userDataPath: app.getPath('userData') }),

    'settings:get': () => getSettings(),
    'settings:update': (patch) => updateSettings(patch),

    'keys:list': () => listKeys(),
    'keys:set': (input) => {
      setKey(input);
      return listKeys();
    },
    'keys:delete': ({ provider }) => {
      deleteKey(provider);
      return listKeys();
    },
    'keys:test': async ({ provider }) => {
      const creds = getProviderCredentials(provider);
      if (!creds) return { ok: false, message: 'No key saved.' };
      try {
        return { ok: true, message: await adapterFor(provider).test(creds) };
      } catch (e) {
        return { ok: false, message: redactSecrets((e as Error).message) };
      }
    },

    'models:list': () => listModels(),
    'models:upsert': (m) => {
      upsertModel(m);
      return listModels();
    },
    'models:delete': ({ id }) => {
      deleteModel(id);
      return listModels();
    },

    'routes:list': () => listRoutes(),
    'routes:update': (r) => {
      upsertRoute(r);
      return listRoutes();
    },
    'routes:test': async ({ task }) => {
      const started = Date.now();
      try {
        const res = await runTask(task, SAMPLE_VARS[task]);
        return {
          ok: true,
          model: res.model.display_name,
          usedFallback: res.usedFallback,
          durationMs: Date.now() - started,
          usage: res.usage,
          output: res.data,
          error: null,
        };
      } catch (e) {
        return {
          ok: false,
          model: '',
          usedFallback: false,
          durationMs: Date.now() - started,
          usage: null,
          output: null,
          error: redactSecrets((e as Error).message),
        };
      }
    },

    'prompts:list': ({ task }) => listPrompts(task),
    'prompts:create': ({ task, content, notes, activate }) => {
      createPromptVersion(task, content, notes, activate);
      return listPrompts(task);
    },
    'prompts:updateNotes': ({ id, notes }) => listPrompts(updatePromptNotes(id, notes)),
    'prompts:setActive': ({ id }) => listPrompts(setActivePrompt(id)),

    'jobs:list': () => listJobs(),
    'jobs:addLinks': ({ text }) => {
      const r = addLinks(text);
      // Greenhouse/Lever/Ashby/Workday links: fetch clean data in the background.
      const ats = r.added.filter((j) => ATS_SOURCE_KEYS.includes(j.sourceKey)).map((j) => j.id);
      if (ats.length) {
        const now = new Date();
        void enrichAtsJobs(ats, { http: getHttp(), now, range: { from: new Date(0), to: now } }).catch((e) => console.error(`[jobs] enrich failed: ${redactSecrets((e as Error)?.message ?? String(e))}`));
      }
      return r;
    },
    'jobs:delete': ({ ids }) => ({ deleted: deleteJobs(ids) }),
    'jobs:needsPaste': () => listNeedsPaste(),
    'jobs:pasteText': ({ id, text }) => {
      savePastedText(id, normalizeText(text));
      appEvents.emit('jobs:updated', { count: 1 });
      return getJobItem(id)!;
    },
    'jobs:retryAllUnreadable': () => {
      const reset = resetAllUnreadable();
      if (reset) appEvents.emit('jobs:updated', { count: reset });
      return { reset };
    },
    'jobs:retryFetch': ({ id }) => {
      resetFetch(id);
      appEvents.emit('jobs:updated', { count: 1 });
      const job = getJobItem(id);
      if (!job) throw new Error('Job not found');
      return job;
    },

    'profiles:list': () => listProfiles(),
    'profiles:get': ({ id }) => getProfile(id),
    'profiles:create': ({ name }) => getProfile(createProfile(name)),
    'profiles:rename': ({ id, name }) => {
      renameProfile(id, name);
      return getProfile(id);
    },
    'profiles:delete': ({ id }) => {
      deleteProfile(id);
      return { ok: true };
    },
    'profiles:savePreferences': ({ id, preferences }) => {
      savePreferences(id, preferences);
      return getProfile(id);
    },

    'resumes:get': ({ id }) => getResume(id),
    'resumes:upload': async ({ profileId, fileName, data }) => {
      const { kind, text } = await extractResumeText(fileName, data);
      const rid = createResume(profileId, { fileName, kind, blob: data, text });
      void parseResume(rid);
      return getResume(rid);
    },
    'resumes:pasteText': ({ profileId, text }) => {
      const clean = normalizeText(text);
      if (clean.replace(/\s/g, '').length < 30) throw new Error('The pasted text is too short to be a resume.');
      const rid = createResume(profileId, { fileName: 'Pasted text', kind: 'pasted', blob: null, text: clean });
      void parseResume(rid);
      return getResume(rid);
    },
    'resumes:reparse': ({ id }) => {
      void parseResume(id);
      return getResume(id);
    },
    'resumes:saveStructured': ({ id, structured }) => {
      saveStructured(id, cleanParsed(structured));
      return getResume(id);
    },
    'resumes:revertStructured': ({ id }) => {
      revertStructured(id);
      return getResume(id);
    },
    'resumes:setActive': ({ id }) => getProfile(setActiveResume(id)),
    'resumes:delete': ({ id }) => getProfile(deleteResume(id)),
    'resumes:openFile': async ({ id }) => {
      const f = getResumeFile(id);
      const dir = join(app.getPath('temp'), 'job-matcher-resumes');
      await mkdir(dir, { recursive: true });
      const safeName = `${id}-${(f.blob ? f.fileName : 'resume.txt').replace(/[^\w.\- ]+/g, '_')}`;
      const path = join(dir, safeName);
      await writeFile(path, f.blob ?? f.text);
      const err = await shell.openPath(path);
      if (err) throw new Error(err);
      return { ok: true };
    },

    'companies:list': () => listCompanies(),
    'companies:detect': ({ url }) => detectCompany(url, getHttp()),
    'companies:add': (input) => {
      addCompany(input);
      return listCompanies();
    },
    'companies:update': ({ id, ...patch }) => {
      updateCompany(id, patch);
      return listCompanies();
    },
    'companies:deleteMany': ({ ids }) => {
      for (const cid of ids) deleteCompany(cid);
      return listCompanies();
    },
    'companies:delete': ({ id }) => {
      deleteCompany(id);
      return listCompanies();
    },
    'companies:test': async ({ id }) => {
      const company = getCompanyRef(id);
      if (!company) throw new Error('Company not found');
      const started = Date.now();
      const now = new Date();
      try {
        const jobs = await sourceAdapterFor(company.atsType).listJobs(company, {
          http: getHttp(),
          now,
          range: { from: new Date(now.getTime() - 30 * 86400_000), to: now },
        });
        return { ok: true, jobsFound: jobs.length, sample: jobs.slice(0, 5).map((j) => j.title), error: null, durationMs: Date.now() - started };
      } catch (e) {
        return { ok: false, jobsFound: 0, sample: [], error: redactSecrets((e as Error).message), durationMs: Date.now() - started };
      }
    },

    'collect:start': (params) => ({ runId: startCollect(params).runId }),
    'collect:cancel': ({ runId }) => {
      cancelRun(runId);
      return { ok: true };
    },
    'collect:resume': ({ runId }) => ({ runId: resumeCollect(runId).runId }),
    'collect:state': () => collectState(),

    'analyze:estimate': (params) => estimate(params),
    'analyze:start': ({ params, budgetOverride }) => ({ runId: startAnalyze({ params, budgetOverride }).runId }),
    'analyze:cancel': ({ runId }) => {
      cancelAnalyze(runId);
      return { ok: true };
    },
    'analyze:resume': ({ runId }) => ({ runId: resumeAnalyze(runId).runId }),
    'analyze:state': () => analyzeState(),
    'analyze:results': ({ runId }) => {
      const s = getSettings();
      return listRunAnalyses(runId, s.weights, s.thresholds);
    },
    'analyze:unreadableDomains': () => listUnreadableDomains(),

    'usage:summary': ({ month }) => usageSummary(month, getSettings().monthlyBudgetUsd),

    'wttj:state': () => wttjState(),
    'wttj:signIn': () => openWttjSignIn(),
    'wttj:signOut': async () => {
      await signOutWttj();
      return { ok: true as const };
    },
    'wttj:import': () => importWttjMatches(),
    'wttj:importLinks': ({ text }) => importWttjLinks(text),

    'results:list': ({ profileId }) => listResults(profileId),
    'results:detail': ({ analysisId }) => getResultDetail(analysisId),
    'results:open': ({ profileId, jobId }) => ({ status: markOpened(profileId, jobId) }),
    'results:setStatus': ({ profileId, jobIds, status }) => ({ updated: setStatuses(profileId, jobIds, status) }),
    'results:feedback': ({ profileId, jobId, feedback, note }) => {
      setFeedback(profileId, jobId, feedback, note);
      return { ok: true };
    },
    'results:export': async ({ profileId, jobIds, options }) => {
      const s = getSettings();
      const { rows, jobIds: exportedIds } = exportRows(profileId, jobIds, s.weights, s.thresholds, options.skipExported);
      const skipped = jobIds.length - exportedIds.length;
      if (!rows.length) return { exported: 0, skipped, path: null, cancelled: false };
      const content = buildExport(rows, options);
      let path: string | null = null;
      if (options.destination === 'clipboard') {
        clipboard.writeText(content);
      } else {
        const win = BrowserWindow.getFocusedWindow();
        const opts = {
          title: 'Export jobs',
          defaultPath: join(app.getPath('documents'), exportFileName(getProfile(profileId).name, options.format, new Date())),
          filters: options.format === 'csv' ? [{ name: 'CSV', extensions: ['csv'] }] : [{ name: 'Text', extensions: ['txt'] }],
        };
        const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
        if (res.canceled || !res.filePath) return { exported: 0, skipped, path: null, cancelled: true };
        await writeFile(res.filePath, content, 'utf8');
        path = res.filePath;
      }
      markExported(profileId, exportedIds);
      return { exported: exportedIds.length, skipped, path, cancelled: false };
    },
  };

  for (const channel of Object.keys(ipcContract) as IpcChannel[]) {
    ipcMain.handle(channel, async (_event, raw: unknown): Promise<IpcResult<unknown>> => {
      const parsed = ipcContract[channel].input.safeParse(raw ?? {});
      if (!parsed.success) return { ok: false, error: `Invalid input for ${channel}: ${parsed.error.message}` };
      try {
        const data = await (handlers[channel] as (i: unknown) => unknown)(parsed.data);
        return { ok: true, data };
      } catch (e) {
        const msg = redactSecrets((e as Error).message ?? String(e));
        console.error(`[ipc] ${channel} failed: ${msg}`);
        return { ok: false, error: msg };
      }
    });
  }
}
