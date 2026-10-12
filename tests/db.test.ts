import { beforeEach, describe, expect, it } from 'vitest';
import { setupTestDb } from './helpers';
import Database from 'better-sqlite3';
import { getDb } from '../src/main/db';
import { runMigrations, MIGRATIONS } from '../src/main/db/migrations';
import { seedDatabase } from '../src/main/seed';
import { PROMPT_UPGRADES, SEED_PROMPTS } from '../src/main/seed/prompts';
import { listModels, upsertModel, deleteModel } from '../src/main/repos/models';
import { listRoutes, upsertRoute } from '../src/main/repos/routes';
import { createPromptVersion, getActivePrompt, listPrompts, setActivePrompt } from '../src/main/repos/prompts';
import { getProviderCredentials, listKeys, setKey, deleteKey } from '../src/main/repos/keys';
import { getSettings, updateSettings } from '../src/main/repos/settings';
import { TASKS } from '@shared/tasks';
import { DEFAULT_SETTINGS } from '@shared/settings';

beforeEach(() => setupTestDb());

describe('migrations & seed', () => {
  it('re-running migrations and seed is a no-op', () => {
    expect(runMigrations(getDb(), MIGRATIONS)).toEqual([]);
    const before = listModels().length;
    seedDatabase();
    expect(listModels().length).toBe(before);
    for (const t of TASKS) expect(listPrompts(t)).toHaveLength(1);
  });

  it('seeds all 9 models, v1 prompts and default routes', () => {
    expect(listModels().map((m) => m.display_name).sort()).toEqual(
      [
        'Claude Haiku 4.5',
        'Claude Opus 5.5',
        'Claude Sonnet 4.6',
        'Claude Sonnet 5',
        'Claude Sonnet 5.5',
        'DeepSeek Flash',
        'DeepSeek Pro',
        'GPT-5.6 Luna',
        'GPT-5.6 Sol',
      ].sort(),
    );
    const opus = listModels().find((m) => m.model_id === 'claude-opus-5-5')!;
    expect(opus).toMatchObject({ thinking_style: 'anthropic_always_on', default_effort: 'medium', server_fallback: true, price_in: 4, price_out: 20 });
    expect(opus.effort_levels).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    const byId = new Map(listModels().map((m) => [m.id, m.display_name]));
    const routes = Object.fromEntries(listRoutes().map((r) => [r.task, r]));
    expect(byId.get(routes.job_extraction.model_id!)).toBe('DeepSeek Flash');
    expect(byId.get(routes.matching.model_id!)).toBe('Claude Sonnet 5');
    expect(routes.matching.thinking_enabled).toBe(true);
    expect(routes.matching.effort).toBe('low');
    expect(byId.get(routes.pre_score.model_id!)).toBe('GPT-5.6 Luna');
    for (const r of listRoutes()) expect(byId.get(r.fallback_model_id!)).toBe('Claude Haiku 4.5');
    for (const t of TASKS) expect(getActivePrompt(t)?.version).toBe(1);
  });
});

describe('upgrade from a v1 database', () => {
  it('adds Sonnet/Opus 5.5 and effort fields without touching user prices', () => {
    // Simulate a v1-era install: Sonnet/Opus 5.5 missing, no effort fields, a user-edited price.
    const db = getDb();
    const s5 = listModels().find((m) => m.model_id === 'claude-sonnet-5')!;
    upsertModel({ ...s5, price_in: 9.99, effort_levels: [], default_effort: null });
    db.prepare("DELETE FROM models WHERE model_id IN ('claude-sonnet-5-5','claude-opus-5-5')").run();
    db.prepare("DELETE FROM settings WHERE key = 'meta:seeded_models_v2'").run();

    seedDatabase();
    const after = listModels();
    expect(after.some((m) => m.model_id === 'claude-sonnet-5-5')).toBe(true);
    expect(after.some((m) => m.model_id === 'claude-opus-5-5')).toBe(true);
    const s5b = after.find((m) => m.model_id === 'claude-sonnet-5')!;
    expect(s5b.price_in).toBe(9.99);
    expect(s5b.effort_levels).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    seedDatabase();
    expect(listModels()).toHaveLength(after.length);
  });

  it('upgrades an unedited v1 extraction prompt to the cache-friendly layout, leaves edited ones alone', () => {
    const db = getDb();
    const v1 = PROMPT_UPGRADES.find((u) => u.task === 'job_extraction')!;
    const reset = (content: string) => {
      db.prepare("DELETE FROM prompts WHERE task = 'job_extraction' AND version > 1").run();
      db.prepare("UPDATE prompts SET content = ?, is_active = 1 WHERE task = 'job_extraction'").run(content);
      db.prepare('DELETE FROM settings WHERE key = ?').run(`meta:${v1.meta}`);
    };

    reset(v1.from);
    seedDatabase();
    expect(getActivePrompt('job_extraction')).toMatchObject({ version: 2, content: SEED_PROMPTS.job_extraction });
    seedDatabase();
    expect(listPrompts('job_extraction')).toHaveLength(2);

    reset(`${v1.from}\nMy own rule.`);
    seedDatabase();
    expect(getActivePrompt('job_extraction')).toMatchObject({ version: 1 });
  });

  it('migration 2 maps thinking_level to effort only for thinking-enabled routes', () => {
    const raw = new Database(':memory:');
    runMigrations(raw, MIGRATIONS.filter((m) => m.id === 1));
    raw.prepare("INSERT INTO task_routes (task, thinking_enabled, thinking_level) VALUES ('matching', 1, 'medium'), ('closed_check', 0, 'low')").run();
    runMigrations(raw, MIGRATIONS);
    const rows = raw.prepare('SELECT task, effort FROM task_routes ORDER BY task').all();
    expect(rows).toEqual([
      { task: 'closed_check', effort: null },
      { task: 'matching', effort: 'medium' },
    ]);
    raw.close();
  });
});

describe('models', () => {
  it('refuses to delete a model used by a route', () => {
    const haiku = listModels().find((m) => m.display_name === 'Claude Haiku 4.5')!;
    expect(() => deleteModel(haiku.id)).toThrow(/task routing/);
  });

  it('forces thinking_style to none when thinking is unsupported', () => {
    const id = upsertModel({
      display_name: 'Test',
      provider: 'openai',
      model_id: 'x',
      supports_thinking: false,
      thinking_style: 'openai_effort',
      supports_json_schema: false,
      effort_levels: ['max', 'low'],
      default_effort: 'high',
      server_fallback: true,
      price_in: 1,
      price_out: 1,
      price_cache_read: 0,
      notes: '',
    });
    const saved = listModels().find((m) => m.id === id)!;
    expect(saved.effort_levels).toEqual(['low', 'max']); // canonical order
    expect(saved.default_effort).toBeNull(); // not a supported level
    expect(saved.server_fallback).toBe(false); // Anthropic-only
    expect(listModels().find((m) => m.id === id)!.thinking_style).toBe('none');
    deleteModel(id);
    expect(listModels().find((m) => m.id === id)).toBeUndefined();
  });

  it('deleting a fallback model is blocked, clearing routes first allows it', () => {
    const sol = listModels().find((m) => m.display_name === 'GPT-5.6 Sol')!;
    const route = listRoutes()[0];
    upsertRoute({ ...route, fallback_model_id: sol.id });
    expect(() => deleteModel(sol.id)).toThrow();
    upsertRoute({ ...route, fallback_model_id: null });
    deleteModel(sol.id);
  });
});

describe('prompts', () => {
  it('edits create new versions; activation is exclusive', () => {
    const id2 = createPromptVersion('matching', 'my prompt {{job_text}}', 'mine', false);
    let list = listPrompts('matching');
    expect(list.map((p) => p.version)).toEqual([2, 1]);
    expect(getActivePrompt('matching')?.version).toBe(1);
    setActivePrompt(id2);
    list = listPrompts('matching');
    expect(list.filter((p) => p.is_active).map((p) => p.version)).toEqual([2]);
    createPromptVersion('matching', 'v3', '', true);
    expect(getActivePrompt('matching')?.version).toBe(3);
    // v1 content is preserved untouched
    expect(listPrompts('matching').find((p) => p.version === 1)!.content).toContain('expert technical recruiter');
  });
});

describe('api keys', () => {
  it('stores keys encrypted and exposes only a mask', () => {
    setKey({ provider: 'anthropic', key: 'sk-ant-secret-ABCD1234' });
    const row = getDb().prepare('SELECT encrypted_key FROM api_keys WHERE provider = ?').get('anthropic') as { encrypted_key: Buffer };
    expect(row.encrypted_key.toString()).not.toContain('sk-ant-secret');
    const info = listKeys().find((k) => k.provider === 'anthropic')!;
    expect(info.masked).toBe('••••1234');
    expect(JSON.stringify(listKeys())).not.toContain('secret');
    expect(getProviderCredentials('anthropic')?.apiKey).toBe('sk-ant-secret-ABCD1234');
  });

  it('defaults the DeepSeek base URL and supports custom providers', () => {
    setKey({ provider: 'deepseek', key: 'k1234' });
    expect(getProviderCredentials('deepseek')?.baseUrl).toBe('https://api.deepseek.com');
    expect(() => setKey({ provider: 'custom:foo', key: 'x' })).toThrow(/base URL/);
    setKey({ provider: 'custom:foo', key: 'xyz9', baseUrl: 'https://example.com/v1', displayName: 'Foo' });
    const foo = listKeys().find((k) => k.provider === 'custom:foo')!;
    expect(foo).toMatchObject({ displayName: 'Foo', isCustom: true, masked: '••••xyz9' });
    deleteKey('custom:foo');
    expect(listKeys().some((k) => k.provider === 'custom:foo')).toBe(false);
  });

  it('keeps the stored key when only the base URL changes', () => {
    setKey({ provider: 'deepseek', key: 'keep-me-0000' });
    setKey({ provider: 'deepseek', baseUrl: 'https://proxy.example.com' });
    expect(getProviderCredentials('deepseek')).toEqual({ apiKey: 'keep-me-0000', baseUrl: 'https://proxy.example.com' });
  });
});

describe('settings', () => {
  it('returns defaults and persists partial updates', () => {
    expect(getSettings()).toEqual(DEFAULT_SETTINGS);
    const s = updateSettings({ concurrency: 8, weights: { ...DEFAULT_SETTINGS.weights, skills: 40 } });
    expect(s.concurrency).toBe(8);
    expect(getSettings().weights.skills).toBe(40);
    expect(getSettings().thresholds).toEqual(DEFAULT_SETTINGS.thresholds);
  });
});
