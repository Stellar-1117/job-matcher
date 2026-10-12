import { getDb } from '../db';
import { TASKS, type TaskKey } from '@shared/tasks';
import type { EffortLevel } from '@shared/types';
import { getMeta, setMeta } from '../repos/settings';
import { findModelByApiId, upsertModel } from '../repos/models';
import { createPromptVersion } from '../repos/prompts';
import { upsertRoute } from '../repos/routes';
import { MODELS_ADDED_IN_V2, SEED_MODELS } from './models';
import { PROMPT_UPGRADES, SEED_PROMPTS } from './prompts';

const DEFAULT_ROUTES: Record<TaskKey, { model: string; thinking: boolean; effort: EffortLevel | null }> = {
  job_extraction: { model: 'DeepSeek Flash', thinking: false, effort: null },
  closed_check: { model: 'DeepSeek Flash', thinking: false, effort: null },
  pre_score: { model: 'GPT-5.6 Luna', thinking: false, effort: null },
  resume_parse: { model: 'Claude Sonnet 5', thinking: false, effort: null },
  matching: { model: 'Claude Sonnet 5', thinking: true, effort: 'low' },
};
const DEFAULT_FALLBACK = 'Claude Haiku 4.5';

/**
 * Idempotent seeding. Models are seeded once (so user deletions stick); later seed versions only
 * add new capability fields to known models and insert newly added models.
 */
export function seedDatabase(): void {
  const db = getDb();
  db.transaction(() => {
    if (!getMeta('seeded_models_v1')) {
      for (const m of SEED_MODELS) upsertModel(m);
      setMeta('seeded_models_v1', new Date().toISOString());
      setMeta('seeded_models_v2', new Date().toISOString());
    } else if (!getMeta('seeded_models_v2')) {
      for (const seed of SEED_MODELS) {
        const existing = findModelByApiId(seed.provider, seed.model_id);
        if (existing) {
          // Only fill in the capability fields introduced in v2; keep the user's prices and notes.
          upsertModel({
            ...existing,
            thinking_style: seed.thinking_style,
            effort_levels: seed.effort_levels,
            default_effort: seed.default_effort,
            server_fallback: seed.server_fallback,
          });
        } else if (MODELS_ADDED_IN_V2.includes(seed.model_id)) {
          upsertModel(seed);
        }
      }
      setMeta('seeded_models_v2', new Date().toISOString());
    }

    for (const task of TASKS) {
      const has = db.prepare('SELECT 1 FROM prompts WHERE task = ?').get(task);
      if (!has) createPromptVersion(task, SEED_PROMPTS[task], 'Default prompt (seeded)', true);
    }
    for (const u of PROMPT_UPGRADES) {
      if (getMeta(u.meta)) continue;
      const active = db.prepare('SELECT content FROM prompts WHERE task = ? AND is_active = 1').get(u.task) as { content: string } | undefined;
      if (active?.content === u.from) createPromptVersion(u.task, SEED_PROMPTS[u.task], u.notes, true);
      setMeta(u.meta, new Date().toISOString());
    }

    const idByName = (name: string): number | null => {
      const r = db.prepare('SELECT id FROM models WHERE display_name = ? ORDER BY id LIMIT 1').get(name) as
        | { id: number }
        | undefined;
      return r?.id ?? null;
    };
    for (const task of TASKS) {
      const has = db.prepare('SELECT 1 FROM task_routes WHERE task = ?').get(task);
      if (has) continue;
      const d = DEFAULT_ROUTES[task];
      upsertRoute({
        task,
        model_id: idByName(d.model),
        thinking_enabled: d.thinking,
        effort: d.effort,
        fallback_model_id: idByName(DEFAULT_FALLBACK),
      });
    }
  })();
}
