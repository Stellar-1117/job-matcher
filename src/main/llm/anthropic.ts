import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { anthropicThinking } from './thinking';
import type { Credentials, ProviderAdapter, ProviderRequest, ProviderResponse } from './types';

/** Server-side refusal fallback: re-runs a classifier-declined request on Anthropic's recommended model. */
const SERVER_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

function client(creds: Credentials): Anthropic {
  return new Anthropic({
    apiKey: creds.apiKey,
    baseURL: creds.baseUrl ?? undefined,
    // The SDK retries 408/409/429/5xx and connection errors with exponential backoff.
    maxRetries: 5,
    timeout: 10 * 60 * 1000,
  });
}

interface MessageLike {
  model: string;
  content: { type: string; text?: string }[];
  stop_reason: string | null;
  usage: {
    input_tokens: number | null;
    output_tokens: number | null;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
}

export const anthropicAdapter: ProviderAdapter = {
  async complete(req: ProviderRequest, creds: Credentials): Promise<ProviderResponse> {
    const t = anthropicThinking(req.model.thinking_style, req.thinking.on, req.thinking.effort, req.maxOutputTokens);

    const outputConfig: Record<string, unknown> = { ...(t.output_config ?? {}) };
    if (req.schema && req.model.supports_json_schema) {
      const fmt = zodOutputFormat(req.schema);
      outputConfig.format = { type: fmt.type, schema: fmt.schema };
    }

    const params = {
      model: req.model.model_id,
      max_tokens: t.max_tokens,
      messages: [
        {
          role: 'user' as const,
          content: req.parts.map((p) => ({
            type: 'text' as const,
            text: p.text,
            ...(p.cache ? { cache_control: { type: 'ephemeral' as const } } : {}),
          })),
        },
      ],
      ...(t.thinking ? { thinking: t.thinking } : {}),
      ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
    };

    // Streaming avoids HTTP timeouts when thinking headroom makes max_tokens large.
    const c = client(creds);
    const msg: MessageLike = req.model.server_fallback
      ? await c.beta.messages
          .stream({ ...params, betas: [SERVER_FALLBACK_BETA], fallbacks: 'default' } as Parameters<Anthropic['beta']['messages']['stream']>[0], {
            signal: req.signal,
          })
          .finalMessage()
      : await c.messages.stream(params as Anthropic.MessageStreamParams, { signal: req.signal }).finalMessage();

    if (msg.stop_reason === 'refusal') {
      throw new Error('Model declined the request (stop_reason: refusal).');
    }
    const text = msg.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    return {
      text,
      stopReason: msg.stop_reason ?? null,
      servedBy: msg.model && msg.model !== req.model.model_id ? msg.model : null,
      usage: {
        uncachedInput: msg.usage.input_tokens ?? 0,
        cacheWrite: msg.usage.cache_creation_input_tokens ?? 0,
        cachedInput: msg.usage.cache_read_input_tokens ?? 0,
        output: msg.usage.output_tokens ?? 0,
      },
    };
  },

  async test(creds: Credentials): Promise<string> {
    const page = await client(creds).models.list({ limit: 5 });
    const ids = page.data.map((m) => m.id);
    return `Key works. Models visible: ${ids.join(', ') || '(none listed)'}`;
  },
};
