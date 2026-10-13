import { z } from 'zod';
import { TASKS } from './tasks';
import { AppSettingsSchema, type AppSettings } from './settings';
import type { AddLinksResult, JobListItem } from './jobs';
import { ResumeParsedSchema } from './llm-schemas';
import { CollectParamsSchema, CompanyInputSchema, type CompanyRow, type DetectResult, type RunProgress } from './collect';
import { AnalyzeParamsSchema, MIN_PASTED_TEXT, type AnalysisRow, type AnalyzeEstimate, type AnalyzeProgress, type UnreadableDomain } from './analysis';
import { ExportOptionsSchema, JOB_STATUSES, type JobStatus, type ResultDetail, type ResultsList } from './results';
import type { UsageSummary } from './usage';
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
  'jobs:addLinks': channel<AddLinksResult>()(z.object({ text: z.string().max(2_000_000) })),
  'jobs:delete': channel<{ deleted: number }>()(z.object({ ids: z.array(z.number().int()).max(100_000) })),
  'jobs:needsPaste': channel<JobListItem[]>()(empty),
  'jobs:pasteText': channel<JobListItem>()(
    z.object({ id, text: z.string().trim().min(MIN_PASTED_TEXT, `Paste at least ${MIN_PASTED_TEXT} characters of the job description`).max(500_000) }),
  ),
  /** Forget an "unreadable" result so the next analysis tries the fetch ladder again. */
  'jobs:retryFetch': channel<JobListItem>()(z.object({ id })),
  'jobs:retryAllUnreadable': channel<{ reset: number }>()(empty),
  'jobs:refetch': channel<{ reset: number }>()(z.object({ ids: z.array(id).min(1).max(100_000) })),

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

  'companies:list': channel<CompanyRow[]>()(empty),
  'companies:detect': channel<DetectResult>()(z.object({ url: z.string().trim().min(1).max(2000) })),
  'companies:add': channel<CompanyRow[]>()(CompanyInputSchema),
  'companies:update': channel<CompanyRow[]>()(CompanyInputSchema.partial().extend({ id, enabled: z.boolean().optional() })),
  'companies:delete': channel<CompanyRow[]>()(z.object({ id })),
  'companies:deleteMany': channel<CompanyRow[]>()(z.object({ ids: z.array(id).max(10_000) })),
  'companies:test': channel<{ ok: boolean; jobsFound: number; sample: string[]; error: string | null; durationMs: number }>()(z.object({ id })),

  'collect:start': channel<{ runId: number }>()(CollectParamsSchema),
  'collect:cancel': channel<{ ok: true }>()(z.object({ runId: id })),
  'collect:resume': channel<{ runId: number }>()(z.object({ runId: id })),
  'collect:state': channel<{ active: RunProgress | null; last: RunProgress | null }>()(empty),

  'analyze:estimate': channel<AnalyzeEstimate>()(AnalyzeParamsSchema),
  'analyze:start': channel<{ runId: number }>()(z.object({ params: AnalyzeParamsSchema, budgetOverride: z.boolean().default(false) })),
  'analyze:cancel': channel<{ ok: true }>()(z.object({ runId: id })),
  'analyze:resume': channel<{ runId: number }>()(z.object({ runId: id })),
  'analyze:state': channel<{ active: AnalyzeProgress | null; last: AnalyzeProgress | null }>()(empty),
  'analyze:results': channel<AnalysisRow[]>()(z.object({ runId: id })),
  'analyze:unreadableDomains': channel<UnreadableDomain[]>()(empty),

  'usage:summary': channel<UsageSummary>()(z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).nullable() })),

  'results:list': channel<ResultsList>()(z.object({ profileId: id })),
  'results:detail': channel<ResultDetail>()(z.object({ analysisId: id })),
  /** Opening a row: new → reviewed for that profile only. */
  'results:open': channel<{ status: JobStatus }>()(z.object({ profileId: id, jobId: id })),
  'results:setStatus': channel<{ updated: number }>()(z.object({ profileId: id, jobIds: z.array(id).max(100_000), status: z.enum(JOB_STATUSES) })),
  'results:feedback': channel<{ ok: true }>()(
    z.object({ profileId: id, jobId: id, feedback: z.union([z.literal(-1), z.literal(0), z.literal(1)]), note: z.string().max(2000).nullable() }),
  ),
  'results:export': channel<{ exported: number; skipped: number; path: string | null; cancelled: boolean }>()(
    z.object({ profileId: id, jobIds: z.array(id).min(1).max(100_000), options: ExportOptionsSchema }),
  ),
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
  'run:progress': RunProgress;
  'analyze:progress': AnalyzeProgress;
  'jobs:updated': { count: number };
}
export type IpcEventName = keyof IpcEvents;

/** Error envelope: handlers never throw across the bridge; the preload re-throws on the renderer side. */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string };

export interface JobMatcherApi {
  invoke<C extends IpcChannel>(channel: C, input: IpcInput<C>): Promise<IpcOutput<C>>;
  on<E extends IpcEventName>(event: E, cb: (payload: IpcEvents[E]) => void): () => void;
}
