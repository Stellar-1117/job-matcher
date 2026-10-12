import {
  ALWAYS_ON_STYLES,
  EFFORT_WITHOUT_THINKING_STYLES,
  clampEffort,
  type EffortLevel,
  type ModelRow,
} from './types';

export interface EffectiveThinking {
  thinkingOn: boolean;
  /** Effort to send explicitly; null = leave the provider default. */
  effort: EffortLevel | null;
  /** Human-readable note when the requested setting was adjusted for this model. */
  note: string | null;
}

/**
 * Resolve what a route's thinking toggle + effort choice means for a specific model. Shared by the
 * main process (request building) and the UI (hints next to the selectors).
 */
export function resolveThinking(
  model: Pick<ModelRow, 'supports_thinking' | 'thinking_style' | 'effort_levels'>,
  thinkingEnabled: boolean,
  requestedEffort: EffortLevel | null,
): EffectiveThinking {
  const style = model.thinking_style;
  const thinkingOn = model.supports_thinking && (ALWAYS_ON_STYLES.includes(style) || thinkingEnabled);
  let effort = clampEffort(requestedEffort, model.effort_levels);
  let note: string | null = null;
  if (requestedEffort && effort && effort !== requestedEffort) note = `"${requestedEffort}" isn't supported; using "${effort}"`;

  if (!thinkingOn && !EFFORT_WITHOUT_THINKING_STYLES.includes(style)) {
    if (effort) note = 'Effort only applies with thinking on';
    effort = null;
  }
  if (style === 'anthropic_between_tools' && !thinkingOn && (effort === 'xhigh' || effort === 'max')) {
    effort = 'high';
    note = 'Capped to "high" while thinking is off';
  }
  return { thinkingOn, effort, note };
}
