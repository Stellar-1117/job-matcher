import OpenAI from 'openai';
import { openAICompatThinking } from './thinking';
import type { Credentials, ProviderAdapter, ProviderRequest, ProviderResponse } from './types';

/**
 * One adapter for OpenAI, DeepSeek (OpenAI-compatible API with a custom baseURL) and any custom
 * OpenAI-compatible provider. Prompt caching is automatic on these APIs (prefix-based), so the
 * stable prompt parts are simply sent first.
 */
export type OpenAIFlavor = 'openai' | 'deepseek' | 'custom';

function client(creds: Credentials): OpenAI {
  return new OpenAI({
    apiKey: creds.apiKey,
    baseURL: creds.baseUrl ?? undefined,
    maxRetries: 5,
    timeout: 10 * 60 * 1000,
  });
}

export function makeOpenAICompatAdapter(flavor: OpenAIFlavor): ProviderAdapter {
  return {
    async complete(req: ProviderRequest, creds: Credentials): Promise<ProviderResponse> {
      const t = openAICompatThinking(req.model.thinking_style, req.thinking.on, req.thinking.effort, req.maxOutputTokens);

      const body: Record<string, unknown> = {
        model: req.model.model_id,
        messages: [{ role: 'user', content: req.parts.map((p) => p.text).join('') }],
      };
      if (flavor === 'openai') body.max_completion_tokens = t.maxTokens;
      else body.max_tokens = t.maxTokens;
      if (t.reasoning_effort) body.reasoning_effort = t.reasoning_effort;
      if (t.thinking) body.thinking = t.thinking; // DeepSeek-specific field, sent in the JSON body
      // JSON mode: our prompts always ask for JSON, which json_object mode requires.
      if (req.schema && flavor !== 'custom') body.response_format = { type: 'json_object' };

      const res = (await client(creds).chat.completions.create(
        body as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming,
        { signal: req.signal },
      )) as OpenAI.ChatCompletion;

      const choice = res.choices[0];
      const u = res.usage as
        | (OpenAI.CompletionUsage & { prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number })
        | undefined;
      let cached = 0;
      let uncached = 0;
      if (u) {
        if (typeof u.prompt_cache_hit_tokens === 'number') {
          cached = u.prompt_cache_hit_tokens;
          uncached = u.prompt_cache_miss_tokens ?? Math.max(0, u.prompt_tokens - cached);
        } else {
          cached = u.prompt_tokens_details?.cached_tokens ?? 0;
          uncached = Math.max(0, u.prompt_tokens - cached);
        }
      }
      return {
        text: choice?.message?.content ?? '',
        stopReason: choice?.finish_reason ?? null,
        usage: { uncachedInput: uncached, cacheWrite: 0, cachedInput: cached, output: u?.completion_tokens ?? 0 },
      };
    },

    async test(creds: Credentials): Promise<string> {
      const page = await client(creds).models.list();
      const ids = page.data.slice(0, 5).map((m) => m.id);
      return `Key works. Models visible: ${ids.join(', ') || '(none listed)'}`;
    },
  };
}
