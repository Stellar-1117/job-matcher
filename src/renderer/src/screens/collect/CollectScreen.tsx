import { useEffect, useMemo, useState } from 'react';
import { ADAPTER_KEYS, ADAPTER_LABELS, type CompanyRow, type RunProgress, type SourceHealthRow } from '@shared/collect';
import type { DateRange } from '@shared/settings';
import { invoke, useIpc, useIpcEvent } from '../../api';
import { Badge, Button, Card, ErrorBox, Spinner, Textarea, cx, useAction } from '../../components/ui';
import DateRangePicker from '../../components/DateRangePicker';
import { ATS_TONES, HealthBadge } from '../settings/CompaniesTab';
import type { Navigate } from '../../App';
import WttjCard from './WttjCard';

function SourcesPicker({
  companies,
  selected,
  onChange,
}: {
  companies: CompanyRow[];
  selected: Set<number>;
  onChange: (s: Set<number>) => void;
}) {
  const groups = ADAPTER_KEYS.map((k) => ({ key: k, items: companies.filter((c) => c.atsType === k && c.enabled) })).filter((g) => g.items.length);
  const toggle = (ids: number[], on: boolean) => {
    const n = new Set(selected);
    for (const id of ids) {
      if (on) n.add(id);
      else n.delete(id);
    }
    onChange(n);
  };
  return (
    <div className="flex flex-col gap-3">
      {groups.map((g) => {
        const ids = g.items.map((c) => c.id);
        const all = ids.every((id) => selected.has(id));
        return (
          <div key={g.key} className="rounded-md border border-slate-200">
            <label className="flex items-center gap-2 border-b border-slate-100 bg-slate-50 px-3 py-1.5 text-sm font-semibold">
              <input type="checkbox" checked={all} onChange={() => toggle(ids, !all)} />
              <Badge tone={ATS_TONES[g.key]}>{ADAPTER_LABELS[g.key]}</Badge>
              <span className="font-normal text-slate-500">
                {ids.filter((id) => selected.has(id)).length}/{ids.length}
              </span>
            </label>
            <div className="grid grid-cols-1 gap-x-4 px-3 py-1.5 lg:grid-cols-2">
              {g.items.map((c) => (
                <label key={c.id} className="flex items-center gap-2 py-1 text-sm">
                  <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle([c.id], !selected.has(c.id))} />
                  <span className="min-w-0 flex-1 truncate">{c.name}</span>
                  <HealthBadge h={c.lastHealth} />
                </label>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function HealthTable({ rows }: { rows: SourceHealthRow[] }) {
  const sorted = [...rows].sort((a, b) => (a.status === b.status ? a.label.localeCompare(b.label) : a.status === 'failed' ? -1 : b.status === 'failed' ? 1 : a.status === 'warning' ? -1 : 1));
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
          <th className="p-2">Source</th>
          <th className="p-2">Status</th>
          <th className="p-2 text-right">Listed</th>
          <th className="p-2 text-right">In range</th>
          <th className="p-2 text-right">New</th>
          <th className="p-2 text-right">Time</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((h) => (
          <tr key={h.id} className={cx('border-b border-slate-100 align-top', h.status === 'failed' && 'bg-red-50/60')}>
            <td className="p-2">
              <div className="font-medium">{h.label}</div>
              {h.error && <div className={cx('text-xs', h.status === 'failed' ? 'text-red-700' : 'text-amber-700')}>{h.error}</div>}
            </td>
            <td className="p-2">
              <Badge tone={h.status === 'ok' ? 'green' : h.status === 'warning' ? 'amber' : 'red'}>{h.status === 'ok' ? 'OK' : h.status}</Badge>
            </td>
            <td className="p-2 text-right tabular-nums">{h.jobsFound}</td>
            <td className="p-2 text-right tabular-nums">{h.jobsInRange}</td>
            <td className="p-2 text-right font-medium tabular-nums">{h.jobsNew}</td>
            <td className="p-2 text-right text-xs tabular-nums text-slate-500">{(h.durationMs / 1000).toFixed(1)}s</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RunPanel({ run, onCancel, onResume, busy }: { run: RunProgress; onCancel: () => void; onResume: () => void; busy: boolean }) {
  const pct = run.total ? Math.round((run.done / run.total) * 100) : 0;
  const running = run.status === 'running';
  const title = running ? 'Collecting…' : run.status === 'completed' ? 'Last collection' : run.status === 'cancelled' ? 'Collection cancelled' : run.status === 'interrupted' ? 'Collection interrupted' : 'Collection failed';
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          {running && <Spinner />}
          {title}
          <span className="text-sm font-normal text-slate-500">{new Date(run.startedAt).toLocaleString()}</span>
        </span>
      }
      actions={
        running ? (
          <Button size="sm" variant="danger" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        ) : run.status === 'interrupted' || run.status === 'cancelled' ? (
          <Button size="sm" variant="primary" onClick={onResume} disabled={busy}>
            Resume ({run.total - run.done} left)
          </Button>
        ) : null
      }
    >
      <div className="mb-3 flex items-center gap-3">
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
          <div className={cx('h-full rounded-full transition-all', run.failed ? 'bg-amber-500' : 'bg-indigo-600')} style={{ width: `${pct}%` }} />
        </div>
        <span className="text-sm tabular-nums text-slate-600">
          {run.done}/{run.total} sources · <span className="font-medium text-slate-800">{run.jobsNew} new jobs</span>
          {run.failed > 0 && <span className="text-red-600"> · {run.failed} failed</span>}
        </span>
      </div>
      {running && run.active.length > 0 && <p className="mb-2 text-xs text-slate-500">Working on: {run.active.join(', ')}</p>}
      {run.health.length > 0 ? <HealthTable rows={run.health} /> : <p className="text-sm text-slate-500">Waiting for the first source…</p>}
    </Card>
  );
}

export default function CollectScreen({ navigate }: { navigate: Navigate }) {
  const companies = useIpc('companies:list', {});
  const settings = useIpc('settings:get', {});
  const state = useIpc('collect:state', {});
  const [range, setRange] = useState<DateRange | null>(null);
  const [selected, setSelected] = useState<Set<number> | null>(null);
  const [links, setLinks] = useState('');
  const [run, setRun] = useState<RunProgress | null>(null);
  const action = useAction();

  const enabled = useMemo(() => (companies.data ?? []).filter((c) => c.enabled), [companies.data]);

  // Initialise from the saved defaults once data arrives.
  useEffect(() => {
    if (settings.data && !range) setRange(settings.data.defaultDateRange);
  }, [settings.data, range]);
  useEffect(() => {
    if (!settings.data || !companies.data || selected) return;
    const defaults = new Set(settings.data.defaultSources.map(Number));
    const ids = enabled.filter((c) => defaults.size === 0 || defaults.has(c.id)).map((c) => c.id);
    setSelected(new Set(ids));
  }, [settings.data, companies.data, enabled, selected]);
  useEffect(() => {
    if (state.data) setRun(state.data.active ?? state.data.last);
  }, [state.data]);

  useIpcEvent('run:progress', (p) => {
    if (p.type !== 'collect') return;
    setRun(p);
    if (p.status !== 'running') void companies.reload();
  });

  const sel = selected ?? new Set<number>();
  const chosen = enabled.filter((c) => sel.has(c.id)).length;
  const running = run?.status === 'running';
  const linkCount = links.split(/\s+/).filter((s) => s.trim()).length;

  const start = () =>
    action.run(async () => {
      if (!range) return;
      await invoke('collect:start', { dateRange: range, companyIds: [...sel], manualLinks: links });
      setLinks('');
    });

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex items-baseline gap-3">
        <h1 className="text-xl font-semibold">Collect</h1>
        <span className="text-sm text-slate-500">Fetch new postings from your companies' career sites and save pasted links.</span>
      </div>

      <Card title="Date range">
        {range && <DateRangePicker value={range} onChange={setRange} />}
        <p className="mt-2 text-xs text-slate-500">
          Only postings inside this window are saved. Dates come from the source when available; otherwise the day the app first saw the posting.
        </p>
      </Card>

      <Card
        title={`Sources (${chosen} of ${enabled.length} selected)`}
        actions={
          <>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set(enabled.map((c) => c.id)))}>
              Select all
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              None
            </Button>
            <Button
              size="sm"
              title="Remember this date range and source selection"
              onClick={() =>
                action.run(async () => {
                  settings.set(await invoke('settings:update', { defaultDateRange: range ?? undefined, defaultSources: [...sel].map(String) }));
                })
              }
            >
              Save as default
            </Button>
            <Button size="sm" onClick={() => navigate('settings', { settingsTab: 'companies' })}>
              Manage companies
            </Button>
          </>
        }
      >
        <ErrorBox error={companies.error} />
        {companies.data && !enabled.length ? (
          <p className="text-sm text-slate-500">
            No companies yet.{' '}
            <button type="button" className="text-indigo-600 hover:underline" onClick={() => navigate('settings', { settingsTab: 'companies' })}>
              Add companies
            </button>{' '}
            by their careers URL — Greenhouse, Lever, Ashby and Workday are detected automatically.
          </p>
        ) : (
          <SourcesPicker companies={companies.data ?? []} selected={sel} onChange={setSelected} />
        )}
      </Card>

      <WttjCard navigate={navigate} />

      <Card title="Manual links">
        <Textarea
          rows={4}
          value={links}
          onChange={(e) => setLinks(e.target.value)}
          placeholder="Paste job links from LinkedIn, Jobright, Welcome to the Jungle… one per line. Greenhouse/Lever/Ashby/Workday links are fetched for clean data."
          className="font-mono text-xs"
        />
      </Card>

      <div className="flex items-center gap-3">
        <Button variant="primary" disabled={action.busy || running || !range || (chosen === 0 && linkCount === 0)} onClick={start}>
          {running ? 'Collecting…' : `Collect${chosen ? ` from ${chosen} source${chosen === 1 ? '' : 's'}` : ''}${linkCount ? ` + ${linkCount} link${linkCount === 1 ? '' : 's'}` : ''}`}
        </Button>
        <ErrorBox error={action.error} />
      </div>

      {run && (
        <RunPanel
          run={run}
          busy={action.busy}
          onCancel={() => action.run(() => invoke('collect:cancel', { runId: run.runId }))}
          onResume={() => action.run(() => invoke('collect:resume', { runId: run.runId }))}
        />
      )}
    </div>
  );
}
