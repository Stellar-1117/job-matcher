import type { EffortLevel, ThinkingStyle } from '@shared/types';

/**
 * Maps the resolved thinking state (on/off + effort, see shared/effort.ts) to each provider's
 * request parameters. Pure functions so they can be unit-tested.
 */

/** Extra output-token headroom for reasoning, since thinking tokens count toward the output cap. */
export const THINKING_HEADROOM: Record<EffortLevel, number> = { low: 4000, medium: 12000, high: 24000, xhigh: 32000, max: 48000 };
export const DEFAULT_HEADROOM = 16000;

/** budget_tokens for models that still use a fixed budget (Claude Haiku 4.5). Minimum is 1024. */
export const ANTHROPIC_BUDGETS: Record<EffortLevel, number> = { low: 2048, medium: 8192, high: 16384, xhigh: 24576, max: 32768 };

const headroom = (effort: EffortLevel | null) => (effort ? THINKING_HEADROOM[effort] : DEFAULT_HEADROOM);

export interface AnthropicThinkingParams {
  max_tokens: number;
  thinking?:
    | { type: 'enabled'; budget_tokens: number }
    | { type: 'adaptive' }
    | { type: 'disabled' }
    | { type: 'between_tools' };
  output_config?: { effort: EffortLevel };
}

export function anthropicThinking(
  style: ThinkingStyle,
  thinkingOn: boolean,
  effort: EffortLevel | null,
  maxOutputTokens: number,
): AnthropicThinkingParams {
  const withEffort = effort ? { output_config: { effort } } : {};
  switch (style) {
    case 'anthropic_budget': {
      // No effort parameter on these models: effort selects the thinking budget.
      if (!thinkingOn) return { max_tokens: maxOutputTokens };
      const budget = ANTHROPIC_BUDGETS[effort ?? 'medium'];
      return { max_tokens: maxOutputTokens + budget, thinking: { type: 'enabled', budget_tokens: budget } };
    }
    case 'anthropic_adaptive':
      // Some adaptive models (e.g. Sonnet 5) think by default, so "off" must be sent explicitly.
      return thinkingOn
        ? { max_tokens: maxOutputTokens + headroom(effort), thinking: { type: 'adaptive' }, ...withEffort }
        : { max_tokens: maxOutputTokens, thinking: { type: 'disabled' }, ...withEffort };
    case 'anthropic_between_tools':
      // Sonnet 5.5: "disabled" is a 400; between_tools is the lowest thinking setting.
      return thinkingOn
        ? { max_tokens: maxOutputTokens + headroom(effort), thinking: { type: 'adaptive' }, ...withEffort }
        : { max_tokens: maxOutputTokens, thinking: { type: 'between_tools' }, ...withEffort };
    case 'anthropic_always_on':
      // Opus 5.5: thinking can't be disabled; omit the field and control depth with effort.
      return { max_tokens: maxOutputTokens + headroom(effort), ...withEffort };
    default:
      return { max_tokens: maxOutputTokens };
  }
}

export interface OpenAICompatThinkingParams {
  maxTokens: number;
  reasoning_effort?: string;
  /** DeepSeek-specific body field. */
  thinking?: { type: 'enabled' | 'disabled' };
}

export function openAICompatThinking(
  style: ThinkingStyle,
  thinkingOn: boolean,
  effort: EffortLevel | null,
  maxOutputTokens: number,
): OpenAICompatThinkingParams {
  if (style === 'openai_effort') {
    if (!thinkingOn) return { maxTokens: maxOutputTokens, reasoning_effort: 'none' };
    return { maxTokens: maxOutputTokens + headroom(effort), ...(effort ? { reasoning_effort: effort } : {}) };
  }
  if (style === 'deepseek_toggle') {
    // DeepSeek thinks by default, so "off" must be sent explicitly.
    if (!thinkingOn) return { maxTokens: maxOutputTokens, thinking: { type: 'disabled' } };
    return {
      maxTokens: maxOutputTokens + headroom(effort),
      thinking: { type: 'enabled' },
      ...(effort ? { reasoning_effort: effort } : {}),
    };
  }
  return { maxTokens: maxOutputTokens };
}
