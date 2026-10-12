import { bool, getDb } from '../db';
import { EFFORT_LEVELS, type EffortLevel, type ModelInput, type ModelRow } from '@shared/types';

function parseEfforts(json: string | null): EffortLevel[] {
  try {
    const arr = JSON.parse(json ?? '[]');
    return Array.isArray(arr) ? EFFORT_LEVELS.filter((e) => arr.includes(e)) : [];
  } catch {
    return [];
  }
}

function toRow(r: any): ModelRow {
  return {
    id: r.id,
    display_name: r.display_name,
    provider: r.provider,
    model_id: r.model_id,
    supports_thinking: bool(r.supports_thinking),
    thinking_style: r.thinking_style,
    supports_json_schema: bool(r.supports_json_schema),
    effort_levels: parseEfforts(r.effort_levels),
    default_effort: r.default_effort ?? null,
    server_fallback: bool(r.server_fallback),
    price_in: r.price_in,
    price_out: r.price_out,
    price_cache_read: r.price_cache_read,
    notes: r.notes,
  };
}

export function listModels(): ModelRow[] {
  return (getDb().prepare('SELECT * FROM models ORDER BY provider, display_name').all() as any[]).map(toRow);
}

export function getModel(id: number): ModelRow | null {
  const r = getDb().prepare('SELECT * FROM models WHERE id = ?').get(id);
  return r ? toRow(r) : null;
}

export function findModelByApiId(provider: string, modelId: string): ModelRow | null {
  const r = getDb().prepare('SELECT * FROM models WHERE provider = ? AND model_id = ? ORDER BY id LIMIT 1').get(provider, modelId);
  return r ? toRow(r) : null;
}

export function upsertModel(m: ModelInput): number {
  const db = getDb();
  // Keep levels in canonical ascending order; drop a default that isn't a supported level.
  const efforts = EFFORT_LEVELS.filter((e) => m.effort_levels.includes(e));
  const params = {
    display_name: m.display_name.trim(),
    provider: m.provider,
    model_id: m.model_id.trim(),
    supports_thinking: m.supports_thinking ? 1 : 0,
    thinking_style: m.supports_thinking ? m.thinking_style : 'none',
    supports_json_schema: m.supports_json_schema ? 1 : 0,
    effort_levels: JSON.stringify(efforts),
    default_effort: m.default_effort && efforts.includes(m.default_effort) ? m.default_effort : null,
    server_fallback: m.server_fallback && m.provider === 'anthropic' ? 1 : 0,
    price_in: m.price_in,
    price_out: m.price_out,
    price_cache_read: m.price_cache_read,
    notes: m.notes,
  };
  if (m.id != null) {
    db.prepare(
      `UPDATE models SET display_name=@display_name, provider=@provider, model_id=@model_id,
        supports_thinking=@supports_thinking, thinking_style=@thinking_style,
        supports_json_schema=@supports_json_schema, effort_levels=@effort_levels, default_effort=@default_effort,
        server_fallback=@server_fallback, price_in=@price_in, price_out=@price_out,
        price_cache_read=@price_cache_read, notes=@notes WHERE id=@id`,
    ).run({ ...params, id: m.id });
    return m.id;
  }
  const res = db
    .prepare(
      `INSERT INTO models (display_name, provider, model_id, supports_thinking, thinking_style,
        supports_json_schema, effort_levels, default_effort, server_fallback, price_in, price_out, price_cache_read, notes)
       VALUES (@display_name, @provider, @model_id, @supports_thinking, @thinking_style,
        @supports_json_schema, @effort_levels, @default_effort, @server_fallback, @price_in, @price_out, @price_cache_read, @notes)`,
    )
    .run(params);
  return Number(res.lastInsertRowid);
}

export function deleteModel(id: number): void {
  const db = getDb();
  const used = db
    .prepare('SELECT task FROM task_routes WHERE model_id = ? OR fallback_model_id = ?')
    .all(id, id) as { task: string }[];
  if (used.length) {
    throw new Error(`Model is used by task routing (${used.map((u) => u.task).join(', ')}). Change those routes first.`);
  }
  db.prepare('DELETE FROM models WHERE id = ?').run(id);
}
