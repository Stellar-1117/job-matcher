import { z } from 'zod';
import { TASKS } from './tasks';
import { AppSettingsSchema, type AppSettings } from './settings';
import type { AddDescriptionResult, AddLinksResult, JobListItem, NeedsPasteJob } from './jobs';
import { ResumeParsedSchema } from './llm-schemas';
import { AnalyzeParamsSchema, MIN_PASTED_TEXT, type AnalysisRow, type AnalyzeEstimate, type AnalyzeProgress, type UnreadableDomain } from './analysis';
import { ExportOptionsSchema, JOB_STATUSES, type JobStatus, type ResultDetail, type ResultsList, type TailoredDetail, type TailoredSummary, type TailorEstimate } from './results';
import type { UsageSummary } from './usage';
import { PASS_WINDOWS_DEFAULT, PASS_WINDOWS_MAX, type HumanPassJob, type HumanPassState, type SiteSession } from './sites';
import { PreferencesSchema, type ParseStatus, type ProfileDetail, type ProfileSummary, type ResumeDetail } from './profile';
import {
  ModelInputSchema,
  ProviderKeySchema,
  TaskRouteSchema,
  type ApiKeyInfo,
  type ModelRow,
  type PromptVersion,
  type TaskRoute,
  type TaskTestResult,
} from './types';

/**
 * Typed IPC contract. Every channel declares a Zod schema for its input (validated in main before
 * the handler runs) and a TypeScript-only output type: `channel<Output>()(inputSchema)`.
 */
const channel =
  <O>() =>
  <I extends z.ZodType>(input: I) => ({ input, output: undefined as unknown as O });

const empty = z.object({}).strict();
const task = z.enum(TASKS);
const id = z.number().int().positive();

export const ipcContract = {
  'app:info': channel<{ version: string; dbPath: string; userDataPath: string }>()(empty),
  'app:copyText': channel<{ ok: true }>()(z.object({ text: z.string().max(5_000_000) })),

  'settings:get': channel<AppSettings>()(empty),
  'settings:update': channel<AppSettings>()(AppSettingsSchema.partial()),

  'keys:list': channel<ApiKeyInfo[]>()(empty),
  'keys:set': channel<ApiKeyInfo[]>()(
    z.object({
      provider: ProviderKeySchema,
      key: z.string().min(1).optional(), // omit to keep the stored key (e.g. only change base URL)
      baseUrl: z.string().url().nullable().optional(),
      displayName: z.string().min(1).max(60).optional(),
    }),
  ),
  'keys:delete': channel<ApiKeyInfo[]>()(z.object({ provider: ProviderKeySchema })),
  'keys:test': channel<{ ok: boolean; message: string }>()(z.object({ provider: ProviderKeySchema })),

  'models:list': channel<ModelRow[]>()(empty),
  'models:upsert': channel<ModelRow[]>()(ModelInputSchema),
  'models:delete': channel<ModelRow[]>()(z.object({ id: z.number().int() })),

  'routes:list': channel<TaskRoute[]>()(empty),
  'routes:update': channel<TaskRoute[]>()(TaskRouteSchema),
  'routes:test': channel<TaskTestResult>()(z.object({ task })),

  'prompts:list': channel<PromptVersion[]>()(z.object({ task })),
  'prompts:create': channel<PromptVersion[]>()(
    z.object({
      task,
      content: z.string().min(1),
      notes: z.string().default(''),
      activate: z.boolean().default(false),
    }),
  ),
  'prompts:updateNotes': channel<PromptVersion[]>()(z.object({ id: z.number().int(), notes: z.string() })),
  'prompts:setActive': channel<PromptVersion[]>()(z.object({ id: z.number().int() })),

  'jobs:list': channel<JobListItem[]>()(empty),
  /** Jobs whose description was given by hand (the Analyze descriptions screen). */
  'jobs:listDescriptions': channel<JobListItem[]>()(empty),
  'jobs:addLinks': channel<AddLinksResult>()(z.object({ text: z.string().max(2_000_000) })),
  'jobs:delete': channel<{ deleted: number }>()(z.object({ ids: z.array(z.number().int()).max(100_000) })),
  'jobs:needsPaste': channel<NeedsPasteJob[]>()(empty),
  'jobs:pasteText': channel<JobListItem>()(
    z.object({ id, text: z.string().trim().min(MIN_PASTED_TEXT, `Paste at least ${MIN_PASTED_TEXT} characters of the job description`).max(500_000) }),
  ),
  /** Forget an "unreadable" result so the next analysis tries the fetch ladder again. */
  'jobs:retryFetch': channel<JobListItem>()(z.object({ id })),
  'jobs:retryAllUnreadable': channel<{ reset: number }>()(empty),
  'jobs:refetch': channel<{ reset: number }>()(z.object({ ids: z.array(id).min(1).max(100_000) })),
  /** Save a job from its description text alone (the link is optional). */
  'jobs:addDescription': channel<AddDescriptionResult>()(
    z.object({
      text: z.string().trim().min(MIN_PASTED_TEXT, `Paste at least ${MIN_PASTED_TEXT} characters of the job description`).max(500_000),
      url: z.string().trim().max(2000).nullable().default(null),
    }),
  ),
  /** Read the text out of an attached job description file (PDF, DOCX, TXT…). */
  'jobs:readDescriptionFile': channel<{ text: string }>()(z.object({ fileName: z.string().min(1).max(255), data: z.instanceof(Uint8Array) })),

  'profiles:list': channel<ProfileSummary[]>()(empty),
  'profiles:get': channel<ProfileDetail>()(z.object({ id })),
  'profiles:create': channel<ProfileDetail>()(z.object({ name: z.string().trim().min(1).max(80) })),
  'profiles:rename': channel<ProfileDetail>()(z.object({ id, name: z.string().trim().min(1).max(80) })),
  'profiles:delete': channel<{ ok: true }>()(z.object({ id })),
  'profiles:savePreferences': channel<ProfileDetail>()(z.object({ id, preferences: PreferencesSchema })),

  'resumes:get': channel<ResumeDetail>()(z.object({ id })),
  'resumes:upload': channel<ResumeDetail>()(
    z.object({ profileId: id, fileName: z.string().min(1).max(255), data: z.instanceof(Uint8Array) }),
  ),
  'resumes:pasteText': channel<ResumeDetail>()(z.object({ profileId: id, text: z.string().min(1).max(500_000) })),
  'resumes:reparse': channel<ResumeDetail>()(z.object({ id })),
  'resumes:saveStructured': channel<ResumeDetail>()(z.object({ id, structured: ResumeParsedSchema })),
  'resumes:revertStructured': channel<ResumeDetail>()(z.object({ id })),
  'resumes:setActive': channel<ProfileDetail>()(z.object({ id })),
  'resumes:delete': channel<ProfileDetail>()(z.object({ id })),
  'resumes:openFile': channel<{ ok: true }>()(z.object({ id })),


  'analyze:estimate': channel<AnalyzeEstimate>()(AnalyzeParamsSchema),
  'analyze:start': channel<{ runId: number }>()(z.object({ params: AnalyzeParamsSchema, budgetOverride: z.boolean().default(false) })),
  'analyze:cancel': channel<{ ok: true }>()(z.object({ runId: id })),
  'analyze:resume': channel<{ runId: number }>()(z.object({ runId: id })),
  'analyze:state': channel<{ active: AnalyzeProgress | null; last: AnalyzeProgress | null }>()(empty),
  'analyze:results': channel<AnalysisRow[]>()(z.object({ runId: id })),
  'analyze:unreadableDomains': channel<UnreadableDomain[]>()(empty),

  /** Links waiting for a person (bot check or sign-in), in the order the human pass opens them. */
  'sites:humanQueue': channel<HumanPassJob[]>()(empty),
  'sites:passState': channel<HumanPassState>()(empty),
  /** Open the waiting links one by one in a visible window (all, or just `jobIds`). */
  'sites:passStart': channel<HumanPassState>()(
    z.object({ jobIds: z.array(id).max(100_000).nullable().default(null), windows: z.number().int().min(1).max(PASS_WINDOWS_MAX).default(PASS_WINDOWS_DEFAULT) }),
  ),
  /** Skip the link one window is on (`jobId`), or every window's when null. */
  'sites:passSkip': channel<{ ok: true }>()(z.object({ jobId: id.nullable().default(null) })),
  'sites:passStop': channel<{ ok: true }>()(empty),
  /** A visible window on the site session, to sign in or sign up; the cookies are kept for later fetches. */
  'sites:openSignIn': channel<{ ok: true }>()(z.object({ url: z.string().trim().url().max(2000) })),
  'sites:sessions': channel<SiteSession[]>()(empty),
  /** Sign out of one site (forget its cookies), or of every site when `domain` is null. */
  'sites:clear': channel<SiteSession[]>()(z.object({ domain: z.string().min(1).max(255).nullable() })),

  'usage:summary': channel<UsageSummary>()(z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).nullable() })),

  'results:list': channel<ResultsList>()(z.object({ profileId: id })),
  'results:detail': channel<ResultDetail>()(z.object({ analysisId: id })),
  'results:setStatus': channel<{ updated: number }>()(z.object({ profileId: id, jobIds: z.array(id).max(100_000), status: z.enum(JOB_STATUSES) })),
  'results:feedback': channel<{ ok: true }>()(
    z.object({ profileId: id, jobId: id, feedback: z.union([z.literal(-1), z.literal(0), z.literal(1)]), note: z.string().max(2000).nullable() }),
  ),
  'results:export': channel<{ exported: number; skipped: number; path: string | null; cancelled: boolean }>()(
    z.object({ profileId: id, jobIds: z.array(id).min(1).max(100_000), options: ExportOptionsSchema }),
  ),

  'tailor:estimate': channel<TailorEstimate>()(z.object({ profileId: id, jobIds: z.array(id).min(1).max(100_000) })),
  'tailor:start': channel<{ started: number }>()(z.object({ profileId: id, jobIds: z.array(id).min(1).max(100_000), budgetOverride: z.boolean().default(false) })),
  /** Tailor one job again (also the Retry after a failure). The file is replaced and its link stays the same. */
  'tailor:regenerate': channel<{ ok: true }>()(z.object({ profileId: id, jobId: id })),
  'tailor:download': channel<{ path: string | null; cancelled: boolean }>()(z.object({ profileId: id, jobId: id })),
  'tailor:link': channel<{ link: string }>()(z.object({ profileId: id, jobId: id })),
  'tailor:changes': channel<TailoredDetail | null>()(z.object({ profileId: id, jobId: id })),
  /** The resume link server: its current address, or why it isn't running. */
  'tailor:server': channel<{ listening: boolean; address: string; error: string | null }>()(empty),
} as const;

export type IpcContract = typeof ipcContract;
export type IpcChannel = keyof IpcContract;
export type IpcInput<C extends IpcChannel> = z.input<IpcContract[C]['input']>;
export type IpcParsedInput<C extends IpcChannel> = z.output<IpcContract[C]['input']>;
export type IpcOutput<C extends IpcChannel> = IpcContract[C]['output'];

/** Main → renderer push events. */
export interface IpcEvents {
  'usage:logged': { task: string; costUsd: number };
  'resume:updated': { resumeId: number; profileId: number; status: ParseStatus };
  'analyze:progress': AnalyzeProgress;
  'jobs:updated': { count: number };
  /** One tailored resume changed state; `status` is the job's status for that profile when the change affected it. */
  'tailor:progress': { summary: TailoredSummary; status: JobStatus | null };
  'sites:pass': HumanPassState;
}
export type IpcEventName = keyof IpcEvents;

/** Error envelope: handlers never throw across the bridge; the preload re-throws on the renderer side. */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string };

export interface JobMatcherApi {
  invoke<C extends IpcChannel>(channel: C, input: IpcInput<C>): Promise<IpcOutput<C>>;
  on<E extends IpcEventName>(event: E, cb: (payload: IpcEvents[E]) => void): () => void;
}
