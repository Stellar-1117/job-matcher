import { bool, getDb } from '../db';
import { TASKS, type TaskKey } from '@shared/tasks';
import type { TaskRoute } from '@shared/types';

function toRoute(r: any): TaskRoute {
  return {
    task: r.task,
    model_id: r.model_id,
    thinking_enabled: bool(r.thinking_enabled),
    effort: r.effort ?? null,
    fallback_model_id: r.fallback_model_id,
  };
}

export function listRoutes(): TaskRoute[] {
  const rows = (getDb().prepare('SELECT * FROM task_routes').all() as any[]).map(toRoute);
  const order = new Map(TASKS.map((t, i) => [t, i]));
  return rows.sort((a, b) => (order.get(a.task) ?? 99) - (order.get(b.task) ?? 99));
}

export function getRoute(task: TaskKey): TaskRoute | null {
  const r = getDb().prepare('SELECT * FROM task_routes WHERE task = ?').get(task);
  return r ? toRoute(r) : null;
}

export function upsertRoute(r: TaskRoute): void {
  getDb()
    .prepare(
      `INSERT INTO task_routes (task, model_id, thinking_enabled, effort, fallback_model_id)
       VALUES (@task, @model_id, @thinking_enabled, @effort, @fallback_model_id)
       ON CONFLICT(task) DO UPDATE SET model_id=excluded.model_id, thinking_enabled=excluded.thinking_enabled,
         effort=excluded.effort, fallback_model_id=excluded.fallback_model_id`,
    )
    .run({ ...r, thinking_enabled: r.thinking_enabled ? 1 : 0 });
}
