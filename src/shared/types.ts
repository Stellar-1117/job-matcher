import { z } from 'zod';
import { TASKS } from './tasks';

// ---- Providers & API keys -------------------------------------------------------------------

export const BUILTIN_PROVIDERS = ['anthropic', 'openai', 'deepseek'] as const;
export type BuiltinProvider = (typeof BUILTIN_PROVIDERS)[number];

/** "anthropic" | "openai" | "deepseek" | "custom:<slug>" */
export const ProviderKeySchema = z
  .string()
  .regex(/^(anthropic|openai|deepseek|custom:[a-z0-9][a-z0-9-]{0,40})$/, 'Invalid provider key');
export type ProviderKey = string;

export const PROVIDER_LABELS: Record<BuiltinProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
};

export const DEFAULT_BASE_URLS: Record<BuiltinProvider, string | null> = {
  anthropic: null,
  openai: null,
  deepseek: 'https://api.deepseek.com',
};

export interface ApiKeyInfo {
  provider: ProviderKey;
  displayName: string;
  baseUrl: string | null;
  /** e.g. "••••1234"; null when no key is stored. The plain key never leaves the main process. */
  masked: string | null;
  isCustom: boolean;
}

// ---- Model registry -------------------------------------------------------------------------

export const THINKING_STYLES = [
  'anthropic_budget',
  'anthropic_adaptive',
  'anthropic_between_tools',
  'anthropic_always_on',
  'openai_effort',
  'deepseek_toggle',
  'none',
] as const;
export type ThinkingStyle = (typeof THINKING_STYLES)[number];

export const THINKING_STYLE_LABELS: Record<ThinkingStyle, string> = {
  anthropic_budget: 'Anthropic budget_tokens',
  anthropic_adaptive: 'Anthropic adaptive (off = disabled)',
  anthropic_between_tools: 'Anthropic adaptive (off = between_tools)',
  anthropic_always_on: 'Anthropic adaptive (always on)',
  openai_effort: 'OpenAI reasoning_effort',
  deepseek_toggle: 'DeepSeek thinking toggle',
  none: 'None',
};

/** Styles where thinking cannot be switched off (effort is the only control). */
export const ALWAYS_ON_STYLES: ThinkingStyle[] = ['anthropic_always_on'];

/**
 * Styles where the effort setting still applies with thinking off. For the others, effort only
 * matters while thinking is on (OpenAI "off" = reasoning_effort none; DeepSeek/Haiku have no effort without thinking).
 */
export const EFFORT_WITHOUT_THINKING_STYLES: ThinkingStyle[] = ['anthropic_adaptive', 'anthropic_between_tools', 'anthropic_always_on'];

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export const ModelInputSchema = z.object({
  id: z.number().int().optional(),
  display_name: z.string().min(1),
  provider: ProviderKeySchema,
  model_id: z.string().min(1),
  supports_thinking: z.boolean(),
  thinking_style: z.enum(THINKING_STYLES),
  supports_json_schema: z.boolean(),
  /** Effort levels the model accepts, in ascending order. Empty = no effort control. */
  effort_levels: z.array(z.enum(EFFORT_LEVELS)),
  /** The provider's default effort for this model (shown as "Model default"). */
  default_effort: z.enum(EFFORT_LEVELS).nullable(),
  /** Anthropic server-side refusal fallback (`fallbacks: "default"`). */
  server_fallback: z.boolean(),
  price_in: z.number().min(0),
  price_out: z.number().min(0),
  price_cache_read: z.number().min(0),
  notes: z.string(),
});
export type ModelInput = z.infer<typeof ModelInputSchema>;
export type ModelRow = Required<ModelInput>;

// ---- Task routing ---------------------------------------------------------------------------

export const TaskRouteSchema = z.object({
  task: z.enum(TASKS),
  model_id: z.number().int().nullable(),
  thinking_enabled: z.boolean(),
  /** null = use the model's default effort. */
  effort: z.enum(EFFORT_LEVELS).nullable(),
  fallback_model_id: z.number().int().nullable(),
});
export type TaskRoute = z.infer<typeof TaskRouteSchema>;

/** Clamp a requested effort onto what a model supports: highest supported level ≤ requested, else the lowest. */
export function clampEffort(requested: EffortLevel | null, supported: readonly EffortLevel[]): EffortLevel | null {
  if (!requested || supported.length === 0) return null;
  if (supported.includes(requested)) return requested;
  const rank = (e: EffortLevel) => EFFORT_LEVELS.indexOf(e);
  const sorted = [...supported].sort((a, b) => rank(a) - rank(b));
  const lower = sorted.filter((e) => rank(e) <= rank(requested));
  return lower.length ? lower[lower.length - 1] : sorted[0];
}

// ---- Prompts --------------------------------------------------------------------------------

export interface PromptVersion {
  id: number;
  task: (typeof TASKS)[number];
  version: number;
  content: string;
  notes: string;
  is_active: boolean;
  created_at: string;
}

// ---- LLM call results -----------------------------------------------------------------------

export interface UsageNumbers {
  /** Uncached input tokens (incl. cache writes). */
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
}

export interface TaskTestResult {
  ok: boolean;
  model: string;
  usedFallback: boolean;
  durationMs: number;
  usage: UsageNumbers | null;
  output: unknown;
  error: string | null;
}
