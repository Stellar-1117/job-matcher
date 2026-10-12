import { describe, expect, it } from 'vitest';
import { anthropicThinking, openAICompatThinking, ANTHROPIC_BUDGETS, DEFAULT_HEADROOM, THINKING_HEADROOM } from '../src/main/llm/thinking';
import { resolveThinking } from '@shared/effort';
import { clampEffort } from '@shared/types';
import { computeCost } from '../src/main/llm/cost';
import { extractJson, renderTemplate, unknownVariables } from '../src/main/llm/template';
import { renderOutputSchema, MatchResultSchema } from '@shared/llm-schemas';
import { renderTaxonomy, snapToTaxonomy, DEFAULT_TAXONOMY } from '@shared/taxonomy';
import { SEED_PROMPTS } from '../src/main/seed/prompts';

describe('thinking parameter mapping', () => {
  it('anthropic budget: off omits thinking, on adds budget on top of output', () => {
    expect(anthropicThinking('anthropic_budget', false, 'low', 1000)).toEqual({ max_tokens: 1000 });
    expect(anthropicThinking('anthropic_budget', true, 'medium', 1000)).toEqual({
      max_tokens: 1000 + ANTHROPIC_BUDGETS.medium,
      thinking: { type: 'enabled', budget_tokens: ANTHROPIC_BUDGETS.medium },
    });
  });

  it('anthropic budget: no effort defaults to the medium budget', () => {
    expect(anthropicThinking('anthropic_budget', true, null, 1000).thinking).toEqual({ type: 'enabled', budget_tokens: ANTHROPIC_BUDGETS.medium });
  });

  it('anthropic adaptive: off is explicit disabled (effort still sent), on sends adaptive + effort', () => {
    expect(anthropicThinking('anthropic_adaptive', false, 'high', 500)).toEqual({
      max_tokens: 500,
      thinking: { type: 'disabled' },
      output_config: { effort: 'high' },
    });
    expect(anthropicThinking('anthropic_adaptive', true, 'low', 500)).toEqual({
      max_tokens: 500 + THINKING_HEADROOM.low,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low' },
    });
    expect(anthropicThinking('anthropic_adaptive', true, null, 500)).toEqual({ max_tokens: 500 + DEFAULT_HEADROOM, thinking: { type: 'adaptive' } });
  });

  it('Sonnet 5.5 style: off is between_tools, never disabled', () => {
    expect(anthropicThinking('anthropic_between_tools', false, 'high', 500)).toEqual({
      max_tokens: 500,
      thinking: { type: 'between_tools' },
      output_config: { effort: 'high' },
    });
    expect(anthropicThinking('anthropic_between_tools', true, 'max', 500).thinking).toEqual({ type: 'adaptive' });
  });

  it('Opus 5.5 style: never sends a thinking field, only effort', () => {
    const p = anthropicThinking('anthropic_always_on', false, 'medium', 500);
    expect(p.thinking).toBeUndefined();
    expect(p.output_config).toEqual({ effort: 'medium' });
    expect(p.max_tokens).toBe(500 + THINKING_HEADROOM.medium);
  });

  it('openai effort: off sends none; on sends the effort or leaves the default', () => {
    expect(openAICompatThinking('openai_effort', false, 'low', 100)).toEqual({ maxTokens: 100, reasoning_effort: 'none' });
    expect(openAICompatThinking('openai_effort', true, 'xhigh', 100).reasoning_effort).toBe('xhigh');
    expect(openAICompatThinking('openai_effort', true, null, 100).reasoning_effort).toBeUndefined();
  });

  it('deepseek toggle: off is explicit disabled, on passes effort', () => {
    expect(openAICompatThinking('deepseek_toggle', false, 'low', 100)).toEqual({ maxTokens: 100, thinking: { type: 'disabled' } });
    expect(openAICompatThinking('deepseek_toggle', true, 'max', 100)).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'max' });
  });
});

describe('resolveThinking / clampEffort', () => {
  const all = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
  const model = (thinking_style: any, effort_levels: any[] = [...all]) => ({ supports_thinking: true, thinking_style, effort_levels });

  it('clamps to the highest supported level at or below the request', () => {
    expect(clampEffort('medium', ['low', 'high', 'max'])).toBe('low');
    expect(clampEffort('xhigh', ['low', 'medium', 'high', 'max'])).toBe('high');
    expect(clampEffort('low', ['high', 'max'])).toBe('high');
    expect(clampEffort(null, ['low'])).toBeNull();
    expect(clampEffort('high', [])).toBeNull();
  });

  it('Opus 5.5 thinking is on even when the toggle is off', () => {
    expect(resolveThinking(model('anthropic_always_on'), false, 'low')).toMatchObject({ thinkingOn: true, effort: 'low' });
  });

  it('Sonnet 5.5 caps effort at high while thinking is off', () => {
    expect(resolveThinking(model('anthropic_between_tools'), false, 'max')).toMatchObject({ thinkingOn: false, effort: 'high' });
    expect(resolveThinking(model('anthropic_between_tools'), true, 'max')).toMatchObject({ thinkingOn: true, effort: 'max' });
  });

  it('drops effort when thinking is off for OpenAI / DeepSeek / Haiku', () => {
    expect(resolveThinking(model('openai_effort'), false, 'high')).toMatchObject({ thinkingOn: false, effort: null });
    expect(resolveThinking(model('deepseek_toggle', ['low', 'high', 'max']), true, 'medium')).toMatchObject({ effort: 'low' });
    expect(resolveThinking(model('anthropic_budget', ['low', 'medium', 'high']), false, 'high').effort).toBeNull();
  });

  it('keeps effort with thinking off for Sonnet 5 / 4.6 style', () => {
    expect(resolveThinking(model('anthropic_adaptive'), false, 'low')).toMatchObject({ thinkingOn: false, effort: 'low' });
  });

  it('a model without thinking support is never on', () => {
    expect(resolveThinking({ supports_thinking: false, thinking_style: 'none', effort_levels: [] }, true, 'high')).toEqual({
      thinkingOn: false,
      effort: null,
      note: null,
    });
  });

  it('style none sends nothing', () => {
    expect(openAICompatThinking('none', true, 'high', 100)).toEqual({ maxTokens: 100 });
    expect(anthropicThinking('none', true, 'high', 100)).toEqual({ max_tokens: 100 });
  });
});

describe('computeCost', () => {
  const prices = { price_in: 2, price_out: 10, price_cache_read: 0.2 };
  it('prices uncached, cache write (1.25×), cache read and output separately', () => {
    const cost = computeCost({ uncachedInput: 1_000_000, cacheWrite: 1_000_000, cachedInput: 1_000_000, output: 1_000_000 }, prices);
    expect(cost).toBeCloseTo(2 + 2.5 + 0.2 + 10, 10);
  });
  it('is zero for zero usage', () => {
    expect(computeCost({ uncachedInput: 0, cacheWrite: 0, cachedInput: 0, output: 0 }, prices)).toBe(0);
  });
});

describe('renderTemplate', () => {
  it('splits the stable prefix (resume/profile) from job-specific content for caching', () => {
    const parts = renderTemplate('Rules\n{{resume_text}}\nJob:\n{{job_text}}\nEnd {{output_schema}}', {
      resume_text: 'RESUME',
      job_text: 'JOB',
      output_schema: '{}',
    });
    expect(parts).toEqual([
      { text: 'Rules\nRESUME\nJob:\n', cache: true },
      { text: 'JOB\nEnd {}' },
    ]);
  });

  it('returns a single uncached part when there is no job variable', () => {
    expect(renderTemplate('Parse {{resume_text}}', { resume_text: 'R' })).toEqual([{ text: 'Parse R' }]);
  });

  it('leaves missing variables untouched', () => {
    expect(renderTemplate('{{taxonomy}}', {})).toEqual([{ text: '{{taxonomy}}' }]);
  });

  it('seeded matching prompt puts resume before the job', () => {
    const parts = renderTemplate(SEED_PROMPTS.matching, { resume_text: 'MY_RESUME', job_text: 'THE_JOB', job_fields: 'FIELDS' });
    expect(parts[0].cache).toBe(true);
    expect(parts[0].text).toContain('MY_RESUME');
    expect(parts[0].text).not.toContain('FIELDS');
    expect(parts[1].text).toContain('THE_JOB');
  });

  it('seeded extraction prompt caches the instructions, taxonomy and schema', () => {
    const parts = renderTemplate(SEED_PROMPTS.job_extraction, { taxonomy: 'TAXONOMY', output_schema: 'SCHEMA', job_text: 'THE_JOB' });
    expect(parts[0]).toMatchObject({ cache: true, text: expect.stringContaining('SCHEMA') });
    expect(parts[0].text).toContain('TAXONOMY');
    expect(parts[1].text).toContain('THE_JOB');
    expect(parts[1].text).not.toContain('SCHEMA');
  });

  it('seed prompts only use known variables', () => {
    for (const p of Object.values(SEED_PROMPTS)) expect(unknownVariables(p)).toEqual([]);
  });
});

describe('extractJson', () => {
  it('parses plain JSON', () => expect(extractJson('{"a":1}')).toEqual({ a: 1 }));
  it('parses fenced JSON', () => expect(extractJson('Here:\n```json\n{"a":2}\n```')).toEqual({ a: 2 }));
  it('parses JSON wrapped in prose', () => expect(extractJson('Sure! {"a":{"b":3}} Done.')).toEqual({ a: { b: 3 } }));
  it('throws when there is no JSON', () => expect(() => extractJson('no json here')).toThrow());
});

describe('schemas and taxonomy', () => {
  it('renders the match schema as JSON Schema text', () => {
    const s = JSON.parse(renderOutputSchema(MatchResultSchema));
    expect(s.properties.sub_scores.properties.skills.properties.score.maximum).toBe(100);
    expect(s.$schema).toBeUndefined();
  });

  it('renders the taxonomy for the prompt', () => {
    expect(renderTaxonomy(DEFAULT_TAXONOMY)).toContain('- work_mode: Remote | Hybrid | Onsite | Unknown');
  });

  it('snaps values onto the allowed list', () => {
    expect(snapToTaxonomy(DEFAULT_TAXONOMY, 'work_mode', 'remote')).toBe('Remote');
    expect(snapToTaxonomy(DEFAULT_TAXONOMY, 'work_mode', 'Anywhere')).toBe('Unknown');
    expect(snapToTaxonomy(DEFAULT_TAXONOMY, 'industry', 'Crypto')).toBe('Other');
    expect(snapToTaxonomy(DEFAULT_TAXONOMY, 'seniority', null)).toBe('Unknown');
  });
});
