import { getDb } from '../db';
import { TASK_META, type TaskKey } from '@shared/tasks';
import { monthKey, type UsageGroup, type UsageRun, type UsageSummary, type UsageTotals } from '@shared/usage';

export interface UsageEntry {
  runId: number | null;
  task: string;
  modelId: number | null;
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
}

export function logUsage(e: UsageEntry): void {
  getDb()
    .prepare(
      `INSERT INTO usage_log (run_id, task, model_id, model_name, input_tokens, output_tokens, cached_tokens, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(e.runId, e.task, e.modelId, e.modelName, e.inputTokens, e.outputTokens, e.cachedTokens, e.costUsd);
}

// ---- Usage screen (§14) ---------------------------------------------------------------------

const emptyTotals = (): UsageTotals => ({ calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 });

function add(t: UsageTotals, r: { input_tokens: number; output_tokens: number; cached_tokens: number; cost_usd: number }): void {
  t.calls++;
  t.inputTokens += r.input_tokens;
  t.outputTokens += r.output_tokens;
  t.cachedTokens += r.cached_tokens;
  t.costUsd += r.cost_usd;
}

function localDayKey(iso: string): string {
  const d = new Date(iso);
  return `${monthKey(d)}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Spend for one (local) month: totals, by task, by model, by day and per run. */
export function usageSummary(month: string | null, budgetUsd: number, now = new Date()): UsageSummary {
  const db = getDb();
  const current = monthKey(now);
  const key = month && /^\d{4}-\d{2}$/.test(month) ? month : current;
  const [y, m] = key.split('-').map(Number);
  const start = new Date(y, m - 1, 1);
  const end = new Date(y, m, 1);
  const rows = db
    .prepare('SELECT run_id, task, model_name, input_tokens, output_tokens, cached_tokens, cost_usd, created_at FROM usage_log WHERE created_at >= ? AND created_at < ? ORDER BY id')
    .all(start.toISOString(), end.toISOString()) as {
    run_id: number | null;
    task: string;
    model_name: string;
    input_tokens: number;
    output_tokens: number;
    cached_tokens: number;
    cost_usd: number;
    created_at: string;
  }[];

  const totals = emptyTotals();
  const byTask = new Map<string, UsageGroup>();
  const byModel = new Map<string, UsageGroup>();
  const byRun = new Map<number | null, UsageTotals>();
  const byDay = new Map<string, { costUsd: number; calls: number }>();
  for (const r of rows) {
    add(totals, r);
    const t = byTask.get(r.task) ?? { key: r.task, label: TASK_META[r.task as TaskKey]?.label ?? r.task, ...emptyTotals() };
    add(t, r);
    byTask.set(r.task, t);
    const mo = byModel.get(r.model_name) ?? { key: r.model_name, label: r.model_name, ...emptyTotals() };
    add(mo, r);
    byModel.set(r.model_name, mo);
    const ru = byRun.get(r.run_id) ?? emptyTotals();
    add(ru, r);
    byRun.set(r.run_id, ru);
    const dk = localDayKey(r.created_at);
    const d = byDay.get(dk) ?? { costUsd: 0, calls: 0 };
    d.costUsd += r.cost_usd;
    d.calls++;
    byDay.set(dk, d);
  }

  const isCurrentMonth = key === current;
  const lastDay = isCurrentMonth ? now.getDate() : new Date(y, m, 0).getDate();
  const days = Array.from({ length: lastDay }, (_, i) => {
    const day = `${key}-${String(i + 1).padStart(2, '0')}`;
    return { day, ...(byDay.get(day) ?? { costUsd: 0, calls: 0 }) };
  });
  const daysInMonth = new Date(y, m, 0).getDate();

  const profileNames = new Map((db.prepare('SELECT id, name FROM profiles').all() as { id: number; name: string }[]).map((p) => [p.id, p.name]));
  const runs: UsageRun[] = [...byRun.entries()].map(([runId, t]) => {
    if (runId == null) return { runId, type: null, status: null, startedAt: null, estimateUsd: null, profiles: [], jobs: null, ...t };
    const run = db.prepare('SELECT type, status, started_at, params_json FROM runs WHERE id = ?').get(runId) as { type: 'collect' | 'analyze'; status: string; started_at: string; params_json: string } | undefined;
    let params: { estimateUsd?: number; profileIds?: number[] } = {};
    try {
      params = run ? JSON.parse(run.params_json) : {};
    } catch {
      params = {};
    }
    const jobs = run ? (db.prepare("SELECT COUNT(*) AS c FROM run_items WHERE run_id = ? AND step = 'prepare'").get(runId) as { c: number }).c : null;
    return {
      runId,
      type: run?.type ?? null,
      status: run?.status ?? 'deleted',
      startedAt: run?.started_at ?? null,
      estimateUsd: typeof params.estimateUsd === 'number' ? params.estimateUsd : null,
      profiles: (params.profileIds ?? []).map((id) => profileNames.get(id) ?? `Profile ${id}`),
      jobs,
      ...t,
    };
  });
  runs.sort((a, b) => (b.startedAt ?? '9999').localeCompare(a.startedAt ?? '9999'));

  const first = db.prepare('SELECT MIN(created_at) AS t FROM usage_log').get() as { t: string | null };
  const months: string[] = [];
  if (first.t) {
    const cursor = new Date(new Date(first.t).getFullYear(), new Date(first.t).getMonth(), 1);
    while (monthKey(cursor) <= current) {
      months.unshift(monthKey(cursor));
      cursor.setMonth(cursor.getMonth() + 1);
    }
  }
  if (!months.includes(current)) months.unshift(current);

  const sortGroups = (g: Map<string, UsageGroup>) => [...g.values()].sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls);
  return {
    month: key,
    months,
    totals,
    budgetUsd,
    isCurrentMonth,
    projectedUsd: isCurrentMonth && now.getDate() > 0 ? (totals.costUsd / now.getDate()) * daysInMonth : null,
    byTask: sortGroups(byTask),
    byModel: sortGroups(byModel),
    byDay: days,
    runs,
  };
}
