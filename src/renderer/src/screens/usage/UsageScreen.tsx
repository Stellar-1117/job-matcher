import { useCallback, useEffect, useRef, useState } from 'react';
import type { UsageGroup, UsageSummary } from '@shared/usage';
import { invoke, useIpcEvent } from '../../api';
import { Badge, Card, ErrorBox, Select, Spinner, cx } from '../../components/ui';
import type { Navigate } from '../../App';
import { usd } from '../../components/format';

const num = (n: number) => n.toLocaleString();
const compact = (n: number) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
const monthLabel = (key: string) => {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
};

/** Single series → one hue (the app accent); no legend needed, the card title names it. */
const BAR = '#4f46e5';
const BAR_HOVER = '#3730a3';

function niceMax(v: number): number {
  if (v <= 0) return 0.01;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

/** Bar with a 4px rounded data end, square at the baseline. */
function barPath(x: number, y: number, w: number, base: number): string {
  const h = base - y;
  if (h <= 0) return '';
  const r = Math.min(4, w / 2, h);
  return `M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${base}Z`;
}

function DailyChart({ days, month }: { days: UsageSummary['byDay']; month: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 760;
  const H = 200;
  const pad = { l: 52, r: 8, t: 10, b: 24 };
  const max = niceMax(Math.max(...days.map((d) => d.costUsd), 0));
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  // The axis always spans the whole month, so early in the month bars don't stretch across the chart.
  const [yy, mm] = month.split('-').map(Number);
  const slots = new Date(yy, mm, 0).getDate();
  const slot = iw / slots;
  const bw = Math.max(2, Math.min(28, slot - 2)); // ≥2px gap between bars
  const yOf = (v: number) => pad.t + ih - (v / max) * ih;
  const ticks = [0, max / 2, max];
  const labelEvery = 5;
  const h = hover != null ? days[hover] : null;

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Daily LLM spend">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={yOf(t)} y2={yOf(t)} stroke="#e2e8f0" strokeWidth={1} />
            <text x={pad.l - 6} y={yOf(t) + 4} textAnchor="end" fontSize={10} fill="#64748b">
              {usd(t)}
            </text>
          </g>
        ))}
        {days.map((d, i) => {
          const x = pad.l + i * slot + (slot - bw) / 2;
          const dayNum = Number(d.day.slice(8));
          return (
            <g key={d.day} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              {/* Hit target: the whole column, bigger than the bar. */}
              <rect x={pad.l + i * slot} y={pad.t} width={slot} height={ih} fill="transparent" />
              <path d={barPath(x, d.costUsd > 0 ? Math.min(yOf(d.costUsd), pad.t + ih - 1) : pad.t + ih, bw, pad.t + ih)} fill={hover === i ? BAR_HOVER : BAR} />
              {(dayNum === 1 || dayNum % labelEvery === 0) && (
                <text x={x + bw / 2} y={H - 8} textAnchor="middle" fontSize={10} fill="#64748b">
                  {dayNum}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {h && hover != null && (
        <div
          className="pointer-events-none absolute -translate-x-1/2 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs shadow-md"
          style={{ left: `${((pad.l + hover * slot + slot / 2) / W) * 100}%`, top: 0 }}
        >
          <div className="font-medium text-slate-800">{new Date(`${h.day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</div>
          <div className="text-slate-600">
            {usd(h.costUsd)} · {num(h.calls)} call{h.calls === 1 ? '' : 's'}
          </div>
        </div>
      )}
    </div>
  );
}

function GroupTable({ rows, total, label }: { rows: UsageGroup[]; total: number; label: string }) {
  if (!rows.length) return <p className="text-sm text-slate-500">No calls.</p>;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
          <th className="py-1.5 pr-2">{label}</th>
          <th className="py-1.5 pr-2 text-right">Calls</th>
          <th className="py-1.5 pr-2 text-right" title="Uncached input · cached input · output">
            Tokens in · cached · out
          </th>
          <th className="py-1.5 pr-2 text-right">Cost</th>
          <th className="w-28 py-1.5">Share</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const share = total > 0 ? r.costUsd / total : 0;
          return (
            <tr key={r.key} className="border-b border-slate-100 last:border-0">
              <td className="py-1.5 pr-2 text-slate-800">{r.label}</td>
              <td className="py-1.5 pr-2 text-right tabular-nums">{num(r.calls)}</td>
              <td className="py-1.5 pr-2 text-right text-xs tabular-nums text-slate-600">
                {compact(r.inputTokens)} · {compact(r.cachedTokens)} · {compact(r.outputTokens)}
              </td>
              <td className="py-1.5 pr-2 text-right font-medium tabular-nums">{usd(r.costUsd)}</td>
              <td className="py-1.5">
                <div className="flex items-center gap-1.5">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
                    <div className="h-full rounded-full" style={{ width: `${share * 100}%`, background: BAR }} />
                  </div>
                  <span className="w-8 text-right text-xs tabular-nums text-slate-500">{Math.round(share * 100)}%</span>
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Tile({ label, value, sub, children }: { label: string; value: string; sub?: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-slate-500">{sub}</div>}
      {children}
    </div>
  );
}

export default function UsageScreen({ navigate }: { navigate: Navigate }) {
  const [month, setMonth] = useState<string | null>(null);
  const [data, setData] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showTable, setShowTable] = useState(false);
  const lastLoad = useRef(0);

  const load = useCallback(async (m: string | null) => {
    setLoading(true);
    lastLoad.current = Date.now();
    try {
      setData(await invoke('usage:summary', { month: m }));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load(month);
  }, [month, load]);
  // Live while an analysis is spending (throttled).
  useIpcEvent('usage:logged', () => {
    if (data?.isCurrentMonth && Date.now() - lastLoad.current > 2000) void load(month);
  });

  const t = data?.totals;
  const budget = data?.budgetUsd ?? 0;
  const pct = budget > 0 && t ? t.costUsd / budget : 0;
  const level = pct >= 1 ? 'over' : pct >= 0.8 ? 'near' : 'ok';

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Usage</h1>
        <span className="text-sm text-slate-500">Every LLM call is logged with its tokens and cost (from the model registry prices).</span>
        <div className="ml-auto flex items-center gap-2">
          {loading && <Spinner />}
          <Select value={data?.month ?? ''} onChange={(e) => setMonth(e.target.value)}>
            {(data?.months ?? []).map((m) => (
              <option key={m} value={m}>
                {monthLabel(m)}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <ErrorBox error={error} />

      {data && t && (
        <>
          <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
            <Tile label={data.isCurrentMonth ? 'Spent this month' : `Spent in ${monthLabel(data.month)}`} value={usd(t.costUsd)} sub={budget > 0 ? `of ${usd(budget)} budget` : 'No budget cap set'}>
              {budget > 0 && (
                <div className="mt-2">
                  <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className={cx('h-full rounded-full', level === 'over' ? 'bg-red-600' : level === 'near' ? 'bg-amber-500' : 'bg-indigo-600')}
                      style={{ width: `${Math.min(100, pct * 100)}%` }}
                    />
                  </div>
                  <div className="mt-1 flex items-center gap-1.5 text-xs text-slate-600">
                    {level !== 'ok' && <Badge tone={level === 'over' ? 'red' : 'amber'}>{level === 'over' ? '⚠ Over budget' : '⚠ Near budget'}</Badge>}
                    {Math.round(pct * 100)}% used
                    <button type="button" className="ml-auto text-indigo-600 hover:underline" onClick={() => navigate('settings', { settingsTab: 'general' })}>
                      Change budget
                    </button>
                  </div>
                </div>
              )}
            </Tile>
            <Tile
              label="Projected"
              value={data.projectedUsd != null ? usd(data.projectedUsd) : '—'}
              sub={data.projectedUsd != null ? 'This month at the current daily rate' : 'Only for the current month'}
            />
            <Tile label="LLM calls" value={num(t.calls)} sub={t.calls ? `${usd(t.costUsd / t.calls)} per call on average` : undefined} />
            <Tile
              label="Tokens"
              value={compact(t.inputTokens + t.cachedTokens + t.outputTokens)}
              sub={`${compact(t.inputTokens)} in · ${compact(t.cachedTokens)} cached · ${compact(t.outputTokens)} out`}
            />
          </div>

          <Card
            title="Daily spend"
            actions={
              <button type="button" className="text-xs text-indigo-600 hover:underline" onClick={() => setShowTable((v) => !v)}>
                {showTable ? 'Show chart' : 'Show as table'}
              </button>
            }
          >
            {t.calls === 0 ? (
              <p className="text-sm text-slate-500">No LLM calls in {monthLabel(data.month)}.</p>
            ) : showTable ? (
              <div className="max-h-72 overflow-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                      <th className="py-1.5">Day</th>
                      <th className="py-1.5 text-right">Calls</th>
                      <th className="py-1.5 text-right">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byDay
                      .filter((d) => d.calls > 0)
                      .map((d) => (
                        <tr key={d.day} className="border-b border-slate-100 last:border-0">
                          <td className="py-1">{new Date(`${d.day}T12:00:00`).toLocaleDateString()}</td>
                          <td className="py-1 text-right tabular-nums">{num(d.calls)}</td>
                          <td className="py-1 text-right tabular-nums">{usd(d.costUsd)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <DailyChart days={data.byDay} month={data.month} />
            )}
          </Card>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <Card title="By task">
              <GroupTable rows={data.byTask} total={t.costUsd} label="Task" />
            </Card>
            <Card title="By model">
              <GroupTable rows={data.byModel} total={t.costUsd} label="Model" />
            </Card>
          </div>

          <Card title="Per run">
            {data.runs.length === 0 ? (
              <p className="text-sm text-slate-500">No runs with LLM calls this month.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="py-1.5 pr-2">Run</th>
                    <th className="py-1.5 pr-2">Started</th>
                    <th className="py-1.5 pr-2">Profiles</th>
                    <th className="py-1.5 pr-2 text-right">Jobs</th>
                    <th className="py-1.5 pr-2 text-right">Calls</th>
                    <th className="py-1.5 pr-2 text-right">Estimated</th>
                    <th className="py-1.5 pr-2 text-right">Actual</th>
                    <th className="py-1.5">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.runs.map((r) => (
                    <tr key={r.runId ?? 'none'} className="border-b border-slate-100 last:border-0">
                      <td className="py-1.5 pr-2">{r.runId == null ? <span className="text-slate-600">Outside runs</span> : `#${r.runId} ${r.type === 'analyze' ? 'Analysis' : r.type ?? ''}`}</td>
                      <td className="py-1.5 pr-2 text-xs text-slate-600">{r.startedAt ? new Date(r.startedAt).toLocaleString() : r.runId == null ? 'Resume parsing, route tests' : '—'}</td>
                      <td className="max-w-48 truncate py-1.5 pr-2 text-xs text-slate-600" title={r.profiles.join(', ')}>
                        {r.profiles.join(', ') || '—'}
                      </td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">{r.jobs ?? '—'}</td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">{num(r.calls)}</td>
                      <td className="py-1.5 pr-2 text-right tabular-nums text-slate-500">{r.estimateUsd != null ? usd(r.estimateUsd) : '—'}</td>
                      <td className="py-1.5 pr-2 text-right font-medium tabular-nums">{usd(r.costUsd)}</td>
                      <td className="py-1.5 text-xs text-slate-600">{r.status ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
