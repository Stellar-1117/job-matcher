import type { z } from 'zod';
import type { EffortLevel, ModelRow } from '@shared/types';

/** One piece of the (single) user message. `cache: true` places a prompt-cache breakpoint after it. */
export interface PromptPart {
  text: string;
  cache?: boolean;
}

export interface ProviderRequest {
  model: ModelRow;
  parts: PromptPart[];
  maxOutputTokens: number;
  /** Already resolved for this model (see shared/effort.ts). */
  thinking: { on: boolean; effort: EffortLevel | null };
  /** Used for provider-native structured output when the model supports it. */
  schema?: z.ZodType;
  signal?: AbortSignal;
}

export interface RawUsage {
  uncachedInput: number;
  cacheWrite: number;
  cachedInput: number;
  output: number;
}

export interface ProviderResponse {
  text: string;
  usage: RawUsage;
  stopReason: string | null;
  /** Set when a server-side fallback model served the response instead of the requested one. */
  servedBy?: string | null;
}

export interface Credentials {
  apiKey: string;
  baseUrl: string | null;
}

export interface ProviderAdapter {
  complete(req: ProviderRequest, creds: Credentials): Promise<ProviderResponse>;
  /** Minimal, free request to validate a key. Returns a human-readable success message. */
  test(creds: Credentials): Promise<string>;
}
