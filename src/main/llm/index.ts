import { z } from 'zod';
import { TASK_META, type TaskKey } from '@shared/tasks';
import { TASK_SCHEMAS, renderOutputSchema, type TaskOutput } from '@shared/llm-schemas';
import { renderTaxonomy } from '@shared/taxonomy';
import { resolveThinking } from '@shared/effort';
import type { ModelRow, TaskRoute, UsageNumbers } from '@shared/types';
import { getModel } from '../repos/models';
import { getRoute } from '../repos/routes';
import { getActivePrompt } from '../repos/prompts';
import { getProviderCredentials } from '../repos/keys';
import { getSettings } from '../repos/settings';
import { logUsage } from '../repos/usage';
import { appEvents } from '../events';
import { redactSecrets } from '../redact';
import { anthropicAdapter } from './anthropic';
import { makeOpenAICompatAdapter } from './openai-compat';
import { computeCost } from './cost';
import { extractJson, renderTemplate, type TemplateVars } from './template';
import type { PromptPart, ProviderAdapter } from './types';

export class LlmValidationError extends Error {
  override name = 'LlmValidationError';
}
export class LlmConfigError extends Error {
  override name = 'LlmConfigError';
}

const adapters = {
  anthropic: anthropicAdapter,
  openai: makeOpenAICompatAdapter('openai'),
  deepseek: makeOpenAICompatAdapter('deepseek'),
  custom: makeOpenAICompatAdapter('custom'),
};

export function adapterFor(provider: string): ProviderAdapter {
  if (provider === 'anthropic') return adapters.anthropic;
  if (provider === 'openai') return adapters.openai;
  if (provider === 'deepseek') return adapters.deepseek;
  if (provider.startsWith('custom:')) return adapters.custom;
  throw new LlmConfigError(`Unknown provider "${provider}"`);
}

export interface CompleteArgs<S extends z.ZodType> {
  task: TaskKey;
  /** Parts of the single user message, stable parts first. */
  parts: PromptPart[];
  schema: S;
  runId?: number | null;
  signal?: AbortSignal;
}

export interface CompleteResult<T> {
  data: T;
  model: ModelRow;
  usedFallback: boolean;
  usage: UsageNumbers;
}

const emptyUsage = (): UsageNumbers => ({ inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 });

function addUsage(total: UsageNumbers, u: UsageNumbers): void {
  total.inputTokens += u.inputTokens;
  total.outputTokens += u.outputTokens;
  total.cachedTokens += u.cachedTokens;
  total.costUsd += u.costUsd;
}

function formatZodError(err: unknown): string {
  if (err instanceof z.ZodError) return z.prettifyError(err);
  return err instanceof Error ? err.message : String(err);
}

async function callModel<S extends z.ZodType>(
  model: ModelRow,
  route: TaskRoute,
  args: CompleteArgs<S>,
  total: UsageNumbers,
): Promise<z.infer<S>> {
  const creds = getProviderCredentials(model.provider);
  if (!creds) throw new LlmConfigError(`No API key saved for provider "${model.provider}".`);
  const adapter = adapterFor(model.provider);
  // The route's effort is clamped onto this model's levels (matters when the fallback model differs).
  const thinking = resolveThinking(model, route.thinking_enabled, route.effort);

  let lastError = '';
  // One normal attempt + one retry that includes the validation error.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (args.signal?.aborted) throw new Error('Cancelled');
    const parts: PromptPart[] =
      attempt === 0
        ? args.parts
        : [
            ...args.parts,
            {
              text: `\n\nYour previous response failed validation:\n${lastError}\nReturn ONLY a corrected JSON object that matches the schema. No prose, no code fences.`,
            },
          ];
    const res = await adapter.complete(
      {
        model,
        parts,
        maxOutputTokens: TASK_META[args.task].maxOutputTokens,
        thinking: { on: thinking.thinkingOn, effort: thinking.effort },
        schema: args.schema,
        signal: args.signal,
      },
      creds,
    );

    const usage: UsageNumbers = {
      inputTokens: res.usage.uncachedInput + res.usage.cacheWrite,
      outputTokens: res.usage.output,
      cachedTokens: res.usage.cachedInput,
      costUsd: computeCost(res.usage, model),
    };
    addUsage(total, usage);
    logUsage({
      runId: args.runId ?? null,
      task: args.task,
      modelId: model.id,
      modelName: res.servedBy ? `${model.display_name} → ${res.servedBy} (server fallback)` : model.display_name,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedTokens: usage.cachedTokens,
      costUsd: usage.costUsd,
    });
    appEvents.emit('usage:logged', { task: args.task, costUsd: usage.costUsd });

    try {
      const parsed = args.schema.safeParse(extractJson(res.text));
      if (parsed.success) return parsed.data;
      lastError = formatZodError(parsed.error);
    } catch (e) {
      lastError = formatZodError(e);
    }
    if (res.stopReason === 'max_tokens' || res.stopReason === 'length') {
      lastError += '\n(The response was cut off by the output token limit — be more concise.)';
    }
  }
  throw new LlmValidationError(`Model output failed validation twice: ${lastError}`);
}

/**
 * Provider-neutral completion for a task: resolves the task route (model, thinking, fallback),
 * validates the JSON output with Zod (one retry including the validation error), logs usage and
 * cost for every call, and falls back to the fallback model when the primary errors after the
 * SDK's own retries.
 */
export async function complete<S extends z.ZodType>(args: CompleteArgs<S>): Promise<CompleteResult<z.infer<S>>> {
  const route = getRoute(args.task);
  if (!route) throw new LlmConfigError(`No route configured for task "${args.task}".`);
  const primary = route.model_id != null ? getModel(route.model_id) : null;
  const fallback = route.fallback_model_id != null ? getModel(route.fallback_model_id) : null;
  if (!primary && !fallback) throw new LlmConfigError(`No model selected for task "${args.task}".`);

  const total = emptyUsage();
  if (primary) {
    try {
      const data = await callModel(primary, route, args, total);
      return { data, model: primary, usedFallback: false, usage: total };
    } catch (e) {
      const cancelled = args.signal?.aborted;
      if (cancelled || e instanceof LlmValidationError || !fallback || fallback.id === primary.id) throw e;
      console.warn(`[llm] ${args.task}: primary model ${primary.display_name} failed, using fallback: ${redactSecrets((e as Error).message)}`);
    }
  }
  const data = await callModel(fallback!, route, args, total);
  return { data, model: fallback!, usedFallback: true, usage: total };
}

export interface RunTaskResult<T> extends CompleteResult<T> {
  promptVersionId: number;
}

/** Render the task's active prompt with the given variables and run it through `complete`. */
export async function runTask<T extends TaskKey>(
  task: T,
  vars: TemplateVars,
  opts: { runId?: number | null; signal?: AbortSignal } = {},
): Promise<RunTaskResult<TaskOutput<T>>> {
  const prompt = getActivePrompt(task);
  if (!prompt) throw new LlmConfigError(`No active prompt for task "${task}".`);
  const schema = TASK_SCHEMAS[task];
  const allVars: TemplateVars = {
    output_schema: renderOutputSchema(schema),
    taxonomy: renderTaxonomy(getSettings().taxonomy),
    ...vars,
  };
  const parts = renderTemplate(prompt.content, allVars);
  const res = await complete({ task, parts, schema, runId: opts.runId, signal: opts.signal });
  return { ...res, data: res.data as TaskOutput<T>, promptVersionId: prompt.id };
}
