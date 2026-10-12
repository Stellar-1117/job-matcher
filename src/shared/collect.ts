import { z } from 'zod';
import { DateRangeSchema } from './settings';

export const ADAPTER_KEYS = ['greenhouse', 'lever', 'ashby', 'workday', 'icims', 'generic'] as const;
/** Sources that are a company's own ATS (preferred as a job's primary link; support single-posting fetch). */
export const ATS_SOURCE_KEYS: readonly string[] = ['greenhouse', 'lever', 'ashby', 'workday', 'icims'];
export type AdapterKeyShared = (typeof ADAPTER_KEYS)[number];

export const ADAPTER_LABELS: Record<AdapterKeyShared, string> = {
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  ashby: 'Ashby',
  workday: 'Workday',
  icims: 'iCIMS',
  generic: 'Generic',
};

export interface CompanyRow {
  id: number;
  name: string;
  careersUrl: string;
  atsType: AdapterKeyShared;
  boardToken: string | null;
  enabled: boolean;
  createdAt: string;
  /** Result of the most recent collection for this company, if any. */
  lastHealth: SourceHealthRow | null;
  jobCount: number;
}

export const CompanyInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  careersUrl: z.string().trim().min(1).max(2000),
  atsType: z.enum(ADAPTER_KEYS),
  boardToken: z.string().trim().max(200).nullable(),
});
export type CompanyInput = z.infer<typeof CompanyInputSchema>;

export interface DetectResult {
  careersUrl: string;
  atsType: AdapterKeyShared;
  boardToken: string | null;
  suggestedName: string | null;
  detectedFrom: 'url' | 'page' | 'none';
  message: string;
}

export type HealthStatus = 'ok' | 'warning' | 'failed';

export interface SourceHealthRow {
  id: number;
  runId: number;
  sourceKey: string;
  companyId: number | null;
  label: string;
  jobsFound: number;
  jobsInRange: number;
  jobsNew: number;
  status: HealthStatus;
  error: string | null;
  durationMs: number;
  createdAt: string;
}

export const CollectParamsSchema = z.object({
  dateRange: DateRangeSchema,
  companyIds: z.array(z.number().int()).max(5000),
  manualLinks: z.string().max(2_000_000),
});
export type CollectParams = z.infer<typeof CollectParamsSchema>;

export type RunStatus = 'running' | 'completed' | 'cancelled' | 'failed' | 'interrupted';

export interface RunProgress {
  runId: number;
  type: 'collect' | 'analyze';
  status: RunStatus;
  total: number;
  done: number;
  failed: number;
  /** Labels of sources currently being processed. */
  active: string[];
  jobsNew: number;
  startedAt: string;
  finishedAt: string | null;
  params: CollectParams;
  health: SourceHealthRow[];
}
