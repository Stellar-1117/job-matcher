import { z } from 'zod';
import { DEFAULT_TAXONOMY, TaxonomySchema } from './taxonomy';
import { DEFAULT_THRESHOLDS, DEFAULT_WEIGHTS, ThresholdsSchema, WeightsSchema } from './scoring';

export const DATE_PRESETS = ['today', 'last7', 'last30', 'custom'] as const;
export type DatePreset = (typeof DATE_PRESETS)[number];

export const DateRangeSchema = z.object({
  preset: z.enum(DATE_PRESETS),
  from: z.string().nullable(), // YYYY-MM-DD, only for custom
  to: z.string().nullable(),
});
export type DateRange = z.infer<typeof DateRangeSchema>;

/** Each key is stored as its own row in the `settings` table. */
export const AppSettingsSchema = z.object({
  weights: WeightsSchema,
  thresholds: ThresholdsSchema,
  taxonomy: TaxonomySchema,
  preScore: z.object({ enabled: z.boolean(), threshold: z.number().min(0).max(100) }),
  feedbackEnabled: z.boolean(),
  monthlyBudgetUsd: z.number().min(0),
  concurrency: z.number().int().min(1).max(32),
  defaultDateRange: DateRangeSchema,
  defaultSources: z.array(z.string()),
  /** The server that hands tailored PDFs to other laptops. host = the address put in links; null finds this PC's LAN address. */
  lan: z.object({ port: z.number().int().min(1024).max(65535), host: z.string().trim().min(1).max(255).nullable() }),
});
export type AppSettings = z.infer<typeof AppSettingsSchema>;
export type SettingsKey = keyof AppSettings;

export const DEFAULT_SETTINGS: AppSettings = {
  weights: DEFAULT_WEIGHTS,
  thresholds: DEFAULT_THRESHOLDS,
  taxonomy: DEFAULT_TAXONOMY,
  preScore: { enabled: false, threshold: 40 },
  feedbackEnabled: false,
  monthlyBudgetUsd: 20,
  concurrency: 4,
  defaultDateRange: { preset: 'last7', from: null, to: null },
  defaultSources: [],
  lan: { port: 47821, host: null },
};
