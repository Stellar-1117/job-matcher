import { beforeEach, describe, expect, it } from 'vitest';
import { setupTestDb } from './helpers';
import { getDb } from '../src/main/db';
import { createRun } from '../src/main/repos/runs';
import { createProfile } from '../src/main/repos/profiles';
import { usageSummary } from '../src/main/repos/usage';

const NOW = new Date(2026, 9, 10, 15, 0, 0); // 10 Oct 2026, local time

function log(task: string, model: string, cost: number, at: Date, runId: number | null = null, tokens = [1000, 200, 300]): void {
  getDb()
    .prepare('INSERT INTO usage_log (run_id, task, model_id, model_name, input_tokens, output_tokens, cached_tokens, cost_usd, created_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)')
    .run(runId, task, model, tokens[0], tokens[1], tokens[2], cost, at.toISOString());
}

beforeEach(() => setupTestDb());

describe('usage summary', () => {
  it('totals, groups, daily series, per-run cost and projection for a month', () => {
    const pid = createProfile('Alex');
    const run = createRun('analyze', { profileIds: [pid], estimateUsd: 0.5 }, 3);
    log('job_extraction', 'DeepSeek Flash', 0.01, new Date(2026, 9, 2, 9), run);
    log('matching', 'Claude Sonnet 5', 0.2, new Date(2026, 9, 2, 9, 5), run);
    log('matching', 'Claude Sonnet 5', 0.3, new Date(2026, 9, 9, 23, 30), run);
    log('resume_parse', 'Claude Sonnet 5', 0.05, new Date(2026, 9, 1, 0, 10)); // outside runs
    log('matching', 'Claude Sonnet 5', 9, new Date(2026, 8, 30, 23, 59)); // September: not counted

    const s = usageSummary(null, 20, NOW);
    expect(s.month).toBe('2026-10');
    expect(s.isCurrentMonth).toBe(true);
    expect(s.totals).toMatchObject({ calls: 4, inputTokens: 4000, outputTokens: 800, cachedTokens: 1200 });
    expect(s.totals.costUsd).toBeCloseTo(0.56);
    expect(s.projectedUsd).toBeCloseTo((0.56 / 10) * 31);
    expect(s.byTask.map((t) => [t.label, t.calls])).toEqual([
      ['Matching', 2],
      ['Resume parse', 1],
      ['Job extraction', 1],
    ]);
    expect(s.byModel[0]).toMatchObject({ label: 'Claude Sonnet 5', calls: 3 });
    expect(s.byDay).toHaveLength(10); // 1–10 Oct, future days omitted
    expect(s.byDay[1]).toMatchObject({ day: '2026-10-02', calls: 2 });
    expect(s.byDay[8].costUsd).toBeCloseTo(0.3);
    expect(s.byDay[4]).toEqual({ day: '2026-10-05', costUsd: 0, calls: 0 });
    const r = s.runs.find((x) => x.runId === run)!;
    expect(r).toMatchObject({ type: 'analyze', calls: 3, estimateUsd: 0.5, profiles: ['Alex'] });
    expect(r.costUsd).toBeCloseTo(0.51);
    expect(s.runs.find((x) => x.runId == null)).toMatchObject({ calls: 1 });
    expect(s.months).toEqual(['2026-10', '2026-09']);

    const sep = usageSummary('2026-09', 20, NOW);
    expect(sep).toMatchObject({ isCurrentMonth: false, projectedUsd: null, totals: { calls: 1, costUsd: 9 } });
    expect(sep.byDay).toHaveLength(30);
  });

  it('an empty month still lists the current month', () => {
    const s = usageSummary(null, 0, NOW);
    expect(s.totals.calls).toBe(0);
    expect(s.months).toEqual(['2026-10']);
    expect(s.runs).toEqual([]);
  });
});
