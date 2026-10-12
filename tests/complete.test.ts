import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderRequest, ProviderResponse } from '../src/main/llm/types';

// Scripted provider responses, shared by the mocked adapters.
const calls: { provider: string; req: ProviderRequest }[] = [];
let script: ((provider: string, req: ProviderRequest) => ProviderResponse | Error)[] = [];

function scripted(provider: string) {
  return {
    async complete(req: ProviderRequest): Promise<ProviderResponse> {
      calls.push({ provider, req });
      const step = script.shift();
      if (!step) throw new Error('unexpected call');
      const out = step(provider, req);
      if (out instanceof Error) throw out;
      return out;
    },
    async test() {
      return 'ok';
    },
  };
}

vi.mock('../src/main/llm/anthropic', () => ({ anthropicAdapter: scripted('anthropic') }));
vi.mock('../src/main/llm/openai-compat', () => ({ makeOpenAICompatAdapter: (flavor: string) => scripted(flavor) }));

const { setupTestDb } = await import('./helpers');
const { runTask, LlmValidationError } = await import('../src/main/llm');
const { setKey } = await import('../src/main/repos/keys');
const { getDb } = await import('../src/main/db');

const usage = { uncachedInput: 1000, cacheWrite: 0, cachedInput: 500, output: 200 };
const ok = (text: string): ProviderResponse => ({ text, usage, stopReason: 'stop' });
const closedOpen = JSON.stringify({ status: 'open', reason: 'accepting applications' });

beforeEach(() => {
  setupTestDb();
  calls.length = 0;
  script = [];
  setKey({ provider: 'deepseek', key: 'ds-key-1111' });
  setKey({ provider: 'anthropic', key: 'an-key-2222' });
});

const usageRows = () => getDb().prepare('SELECT task, model_name, input_tokens, cached_tokens, output_tokens, cost_usd FROM usage_log').all() as any[];

describe('complete / runTask', () => {
  it('validates output, logs usage with cost from the registry', async () => {
    script = [() => ok(closedOpen)];
    const res = await runTask('closed_check', { job_text: 'A job' });
    expect(res.data).toEqual({ status: 'open', reason: 'accepting applications' });
    expect(res.model.display_name).toBe('DeepSeek Flash');
    expect(res.usedFallback).toBe(false);
    expect(calls[0].req.thinking.on).toBe(false);
    const rows = usageRows();
    expect(rows).toHaveLength(1);
    // DeepSeek Flash seed prices: 0.30 in, 1.20 out, 0.006 cache → (1000*0.3 + 500*0.006 + 200*1.2)/1e6
    expect(rows[0].cost_usd).toBeCloseTo((1000 * 0.3 + 500 * 0.006 + 200 * 1.2) / 1e6, 12);
    expect(rows[0]).toMatchObject({ task: 'closed_check', model_name: 'DeepSeek Flash', input_tokens: 1000, cached_tokens: 500, output_tokens: 200 });
  });

  it('retries once with the validation error, then succeeds', async () => {
    script = [() => ok('{"status":"maybe"}'), () => ok(closedOpen)];
    const res = await runTask('closed_check', { job_text: 'A job' });
    expect(res.data.status).toBe('open');
    expect(calls).toHaveLength(2);
    expect(calls[1].req.parts.at(-1)!.text).toContain('failed validation');
    expect(usageRows()).toHaveLength(2);
  });

  it('fails after two invalid outputs without using the fallback', async () => {
    script = [() => ok('nonsense'), () => ok('{"status":"nope"}')];
    await expect(runTask('closed_check', { job_text: 'A job' })).rejects.toBeInstanceOf(LlmValidationError);
    expect(calls.map((c) => c.provider)).toEqual(['deepseek', 'deepseek']);
  });

  it('uses the fallback model when the primary errors', async () => {
    script = [() => new Error('503 overloaded'), () => ok(closedOpen)];
    const res = await runTask('closed_check', { job_text: 'A job' });
    expect(res.usedFallback).toBe(true);
    expect(res.model.display_name).toBe('Claude Haiku 4.5');
    expect(calls.map((c) => c.provider)).toEqual(['deepseek', 'anthropic']);
  });

  it('falls back when the primary provider has no key', async () => {
    getDb().prepare('DELETE FROM api_keys WHERE provider = ?').run('deepseek');
    script = [() => ok(closedOpen)];
    const res = await runTask('closed_check', { job_text: 'A job' });
    expect(res.usedFallback).toBe(true);
  });

  it('passes route thinking settings and the cache split to the provider', async () => {
    const matchOut = {
      sub_scores: {
        skills: { score: 80, reason: 'r' },
        domain_fit: { score: 70, reason: 'r' },
        project_similarity: { score: 60, reason: 'r' },
        experience_fit: { score: 90, reason: 'r' },
        preferences_fit: { score: 50, reason: 'r' },
      },
      strengths: [{ point: 'Go', resume_evidence: 'built a ledger in Go' }],
      gaps: [{ point: 'no Kafka', severity: 'low' }],
      summary: 'Solid backend fit',
    };
    script = [() => ok(JSON.stringify(matchOut))];
    const res = await runTask('matching', {
      profile_structured: '{}',
      soft_preferences: '{}',
      resume_text: 'RESUME',
      job_fields: '{}',
      job_text: 'JOB',
    });
    expect(res.data.summary).toBe('Solid backend fit');
    const req = calls[0].req;
    expect(calls[0].provider).toBe('anthropic');
    expect(req.model.model_id).toBe('claude-sonnet-5');
    expect(req.thinking).toEqual({ on: true, effort: 'low' });
    expect(req.parts[0].cache).toBe(true);
    expect(req.parts[0].text).toContain('RESUME');
    expect(req.parts[1].text).toContain('JOB');
    expect(res.promptVersionId).toBeGreaterThan(0);
  });
});
