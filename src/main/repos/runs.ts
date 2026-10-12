import { getDb, nowIso } from '../db';
import type { HealthStatus, RunStatus, SourceHealthRow } from '@shared/collect';

export interface RunRow {
  id: number;
  type: 'collect' | 'analyze';
  params: unknown;
  status: RunStatus;
  total: number;
  done: number;
  failed: number;
  costUsd: number;
  startedAt: string;
  finishedAt: string | null;
}

function toRun(r: any): RunRow {
  return {
    id: r.id,
    type: r.type,
    params: JSON.parse(r.params_json),
    status: r.status,
    total: r.total,
    done: r.done,
    failed: r.failed,
    costUsd: r.cost_usd,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

export function toHealthRow(h: any): SourceHealthRow {
  return {
    id: h.id,
    runId: h.run_id,
    sourceKey: h.source_key,
    companyId: h.company_id,
    label: h.label,
    jobsFound: h.jobs_found,
    jobsInRange: h.jobs_in_range,
    jobsNew: h.jobs_new,
    status: h.status,
    error: h.error,
    durationMs: h.duration_ms,
    createdAt: h.created_at,
  };
}

export function createRun(type: RunRow['type'], params: unknown, total: number): number {
  const res = getDb()
    .prepare("INSERT INTO runs (type, params_json, status, total, started_at) VALUES (?, ?, 'running', ?, ?)")
    .run(type, JSON.stringify(params), total, nowIso());
  return Number(res.lastInsertRowid);
}

export function getRun(id: number): RunRow | null {
  const r = getDb().prepare('SELECT * FROM runs WHERE id = ?').get(id);
  return r ? toRun(r) : null;
}

export function latestRun(type: RunRow['type']): RunRow | null {
  const r = getDb().prepare('SELECT * FROM runs WHERE type = ? ORDER BY id DESC LIMIT 1').get(type);
  return r ? toRun(r) : null;
}

export function updateRunProgress(id: number, p: { done: number; failed: number; total?: number }): void {
  getDb().prepare('UPDATE runs SET done = ?, failed = ?, total = COALESCE(?, total) WHERE id = ?').run(p.done, p.failed, p.total ?? null, id);
}

export function setRunStatus(id: number, status: RunStatus): void {
  const finished = status === 'running' ? null : nowIso();
  getDb().prepare('UPDATE runs SET status = ?, finished_at = ? WHERE id = ?').run(status, finished, id);
}

export function runningRunIds(type: RunRow['type']): number[] {
  return (getDb().prepare("SELECT id FROM runs WHERE type = ? AND status = 'running' ORDER BY id").all(type) as { id: number }[]).map((r) => r.id);
}

/** LLM spend logged for a run (includes calls whose item later failed). */
export function runUsageCost(id: number): number {
  return (getDb().prepare('SELECT COALESCE(SUM(cost_usd), 0) AS s FROM usage_log WHERE run_id = ?').get(id) as { s: number }).s;
}

export function setRunCost(id: number, usd: number): void {
  getDb().prepare('UPDATE runs SET cost_usd = ? WHERE id = ?').run(usd, id);
}

/** Runs left "running" by a previous app session can't still be running. */
export function markInterruptedRuns(): number {
  return getDb().prepare("UPDATE runs SET status = 'interrupted', finished_at = ? WHERE status = 'running'").run(nowIso()).changes;
}

export function addSourceHealth(h: {
  runId: number;
  sourceKey: string;
  companyId: number | null;
  label: string;
  jobsFound: number;
  jobsInRange: number;
  jobsNew: number;
  status: HealthStatus;
  error: string | null;
  durationMs: number;
}): SourceHealthRow {
  const res = getDb()
    .prepare(
      `INSERT INTO source_health (run_id, source_key, company_id, label, jobs_found, jobs_in_range, jobs_new, status, error, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(h.runId, h.sourceKey, h.companyId, h.label, h.jobsFound, h.jobsInRange, h.jobsNew, h.status, h.error, h.durationMs);
  return toHealthRow(getDb().prepare('SELECT * FROM source_health WHERE id = ?').get(Number(res.lastInsertRowid)));
}

export function listSourceHealth(runId: number): SourceHealthRow[] {
  return (getDb().prepare('SELECT * FROM source_health WHERE run_id = ? ORDER BY id').all(runId) as any[]).map(toHealthRow);
}
