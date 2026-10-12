import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AnalysisRow, AnalyzeEstimate, AnalyzeParamsInput, AnalyzeProgress, MatchOutcome, PrepareOutcome } from '@shared/analysis';
import type { DateRange } from '@shared/settings';
import type { JobDateField } from '@shared/dates';
import type { JobListItem } from '@shared/jobs';
import { VERDICT_LABELS } from '@shared/scoring';
import { TASK_META } from '@shared/tasks';
import { invoke, useIpc, useIpcEvent } from '../../api';
import { Badge, Button, Card, ErrorBox, Spinner, Toggle, cx, useAction } from '../../components/ui';
import { useConfirm } from '../../components/confirm';
import DateRangePicker from '../../components/DateRangePicker';
import type { Navigate } from '../../App';
import { VERDICT_TONES, usd } from '../../components/format';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const PREPARE_LABELS: Record<PrepareOutcome, string> = {
  extracted: 'extracted',
  cached: 'already extracted',
  closed: 'closed',
  needs_text: 'need a pasted description',
};
const MATCH_LABELS: Record<MatchOutcome, string> = {
  matched: 'matched',
  cached: 'already analyzed',
  hard_filter: 'failed hard filters',
  pre_score_skip: 'skipped by pre-score',
  job_closed: 'job closed',
  needs_text: 'waiting for a description',
};

function Bar({ done, total, warn }: { done: number; total: number; warn?: boolean }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
      <div className={cx('h-full rounded-full transition-all', warn ? 'bg-amber-500' : 'bg-indigo-600')} style={{ width: `${pct}%` }} />
    </div>
  );
}

function Outcomes<K extends string>({ counts, labels }: { counts: Partial<Record<K, number>>; labels: Record<K, string> }) {
  const entries = (Object.keys(labels) as K[]).filter((k) => counts[k]);
  if (!entries.length) return null;
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-600">
      {entries.map((k) => (
        <span key={k}>
          <span className="font-medium tabular-nums text-slate-800">{counts[k]}</span> {labels[k]}
        </span>
      ))}
    </span>
  );
}

function RunPanel({ run, busy, onCancel, onResume }: { run: AnalyzeProgress; busy: boolean; onCancel: () => void; onResume: () => void }) {
  const [showErrors, setShowErrors] = useState(false);
  const running = run.status === 'running';
  const title = running
    ? 'Analyzing…'
    : run.status === 'completed'
      ? 'Last analysis'
      : run.status === 'cancelled'
        ? 'Analysis cancelled'
        : run.status === 'interrupted'
          ? 'Analysis interrupted'
          : 'Analysis failed';
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
        ) : run.remaining > 0 ? (
          <Button size="sm" variant="primary" onClick={onResume} disabled={busy} title="Process the items that are pending, failed or were waiting for a pasted description">
            Resume ({run.remaining} left)
          </Button>
        ) : null
      }
    >
      <div className="flex flex-col gap-2.5">
        <div className="flex items-center gap-3">
          <span className="w-40 text-sm text-slate-600">Jobs prepared</span>
          <Bar done={run.jobs.finished} total={run.jobs.total} />
          <span className="w-24 text-right text-sm tabular-nums text-slate-700">
            {run.jobs.finished}/{run.jobs.total}
          </span>
        </div>
        <div className="pl-40">
          <Outcomes counts={run.prepareOutcomes} labels={PREPARE_LABELS} />
        </div>
        <div className="flex items-center gap-3">
          <span className="w-40 text-sm text-slate-600">Job × profile matches</span>
          <Bar done={run.matches.finished} total={run.matches.total} warn={run.failed > 0} />
          <span className="w-24 text-right text-sm tabular-nums text-slate-700">
            {run.matches.finished}/{run.matches.total}
          </span>
        </div>
        <div className="pl-40">
          <Outcomes counts={run.matchOutcomes} labels={MATCH_LABELS} />
        </div>
        <div className="flex flex-wrap items-center gap-4 border-t border-slate-100 pt-2 text-sm">
          <span>
            Cost so far <span className="font-semibold tabular-nums">{usd(run.costUsd)}</span>
            {run.estimateUsd != null && <span className="text-slate-500"> (estimated {usd(run.estimateUsd)})</span>}
          </span>
          {run.failed > 0 && (
            <button type="button" className="text-red-600 hover:underline" onClick={() => setShowErrors((v) => !v)}>
              {plural(run.failed, 'item')} failed {showErrors ? '▾' : '▸'}
            </button>
          )}
          {run.blocked > 0 && <span className="text-amber-700">{plural(run.blocked, 'item')} waiting (see "Needs manual paste")</span>}
        </div>
        {running && run.active.length > 0 && <p className="text-xs text-slate-500">Working on: {run.active.join(' | ')}</p>}
        {showErrors && run.errors.length > 0 && (
          <div className="max-h-64 overflow-auto rounded-md border border-red-100 bg-red-50/50 p-2 text-xs">
            {run.errors.map((e) => (
              <div key={e.itemId} className="border-b border-red-100 py-1 last:border-0">
                <span className="font-medium text-slate-800">{e.jobTitle ?? `Job ${e.jobId}`}</span>
                {e.companyName && <span className="text-slate-500"> · {e.companyName}</span>}
                {e.profileName && <span className="text-slate-500"> · {e.profileName}</span>}
                <span className="text-slate-400"> ({e.step === 'prepare' ? 'fetch / extraction' : 'matching'})</span>
                <div className="text-red-700">{e.error}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

function ResultsPreview({ rows, onOpenResults }: { rows: AnalysisRow[]; onOpenResults: () => void }) {
  const [showFiltered, setShowFiltered] = useState(false);
  const matched = rows.filter((r) => r.outcome === 'matched' && !r.hardFilterReasons.length);
  const filtered = rows.filter((r) => r.outcome !== 'matched' || r.hardFilterReasons.length);
  return (
    <Card
      title={`Results of this run (${matched.length} scored)`}
      actions={
        <Button size="sm" variant="primary" onClick={onOpenResults}>
          Open Results
        </Button>
      }
    >
      <p className="mb-2 text-xs text-slate-500">A quick look at this run. Use Results for filters, details, status and export.</p>
      {matched.length === 0 ? (
        <p className="py-3 text-sm text-slate-500">No scored jobs yet.</p>
      ) : (
        <table className="w-full table-fixed text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="w-16 p-2">Score</th>
              <th className="w-20 p-2">Verdict</th>
              <th className="p-2">Job</th>
              <th className="w-32 p-2">Profile</th>
              <th className="w-[40%] p-2">Summary</th>
            </tr>
          </thead>
          <tbody>
            {matched.map((r) => (
              <tr key={r.analysisId} className="border-b border-slate-100 align-top last:border-0">
                <td className="p-2 text-base font-semibold tabular-nums">{r.total}</td>
                <td className="p-2">{r.verdict && <Badge tone={VERDICT_TONES[r.verdict]}>{VERDICT_LABELS[r.verdict]}</Badge>}</td>
                <td className="min-w-0 p-2">
                  <a href={r.url} target="_blank" rel="noreferrer" className="block truncate font-medium text-indigo-700 hover:underline" title={r.url}>
                    {r.title ?? r.url}
                  </a>
                  <div className="truncate text-xs text-slate-500">{r.companyName}</div>
                </td>
                <td className="truncate p-2 text-slate-600">{r.profileName}</td>
                <td className="p-2 text-xs text-slate-600">{r.summary}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {filtered.length > 0 && (
        <div className="mt-3">
          <button type="button" className="text-sm text-slate-600 hover:underline" onClick={() => setShowFiltered((v) => !v)}>
            {showFiltered ? '▾' : '▸'} {plural(filtered.length, 'job')} filtered out (hard filters or pre-score — no matching cost)
          </button>
          {showFiltered && (
            <div className="mt-2 max-h-72 overflow-auto rounded-md border border-slate-200 text-xs">
              {filtered.map((r) => (
                <div key={r.analysisId} className="border-b border-slate-100 px-3 py-1.5 last:border-0">
                  <a href={r.url} target="_blank" rel="noreferrer" className="font-medium text-indigo-700 hover:underline">
                    {r.title ?? r.url}
                  </a>
                  <span className="text-slate-500">
                    {r.companyName ? ` · ${r.companyName}` : ''} · {r.profileName}
                  </span>
                  <div className="text-slate-600">
                    {r.hardFilterReasons.length ? r.hardFilterReasons.join('; ') : `Pre-score ${r.preScore ?? '?'}: ${r.preScoreReason ?? ''}`}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function NeedsPasteCard({ jobs, onPaste }: { jobs: JobListItem[]; onPaste: (j: JobListItem) => void }) {
  const domains = useIpc('analyze:unreadableDomains', {}, [jobs.length]);
  const retry = useAction();
  return (
    <Card
      title={`Needs manual paste (${jobs.length})`}
      actions={
        <Button
          size="sm"
          disabled={retry.busy}
          title="Fetch these pages again on the next analysis run (they leave this list until then)"
          onClick={() => void retry.run(() => invoke('jobs:retryAllUnreadable', {}))}
        >
          Retry fetching all
        </Button>
      }
    >
      <p className="mb-2 text-xs text-slate-500">
        These pages couldn't be read automatically (login wall, bot check, or JavaScript the hidden browser couldn't render). Paste each description, then click Resume on the analysis.
      </p>
      <ErrorBox error={retry.error} />
      <div className="max-h-80 overflow-auto rounded-md border border-slate-200">
        {jobs.map((j) => (
          <div key={j.id} className="flex items-start gap-3 border-b border-slate-100 px-3 py-2 last:border-0">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-slate-800">
                {j.title ?? j.url.replace(/^https:\/\//, '')}
                {j.companyName && <span className="font-normal text-slate-500"> · {j.companyName}</span>}
              </div>
              <div className="truncate text-xs text-amber-700" title={j.fetchError ?? ''}>
                {j.fetchError}
              </div>
            </div>
            <Button size="sm" variant="primary" onClick={() => onPaste(j)}>
              Paste description
            </Button>
          </div>
        ))}
      </div>
      {domains.data && domains.data.length > 0 && (
        <details className="mt-3 text-xs">
          <summary className="cursor-pointer text-slate-600">Unreadable domains (to decide which sites deserve a dedicated adapter)</summary>
          <table className="mt-1 w-full">
            <tbody>
              {domains.data.map((d) => (
                <tr key={d.domain} className="border-b border-slate-100 align-top last:border-0">
                  <td className="py-1 pr-3 font-mono">{d.domain}</td>
                  <td className="py-1 pr-3 tabular-nums">{d.count}×</td>
                  <td className="py-1 text-slate-500">{d.lastReason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </Card>
  );
}

function EstimateView({ est }: { est: AnalyzeEstimate }) {
  const over = est.exceedsBudget;
  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="text-base">
        <span className="font-semibold">{plural(est.jobs, 'job')}</span> × <span className="font-semibold">{plural(est.profiles, 'profile')}</span> — est.{' '}
        <span className={cx('font-semibold', over && 'text-red-600')}>{usd(est.totalUsd)}</span>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-slate-600">
        {est.needFetch > 0 && <span>{est.needFetch} to fetch</span>}
        <span>{est.needExtraction} to extract</span>
        <span>{est.needMatching} to match</span>
        {est.cached > 0 && <span>{est.cached} already analyzed (free)</span>}
        {est.hardFiltered > 0 && <span>{est.hardFiltered} fail hard filters (free)</span>}
        {est.needPaste > 0 && <span className="text-amber-700">{est.needPaste} waiting for a pasted description</span>}
      </div>
      <table className="mt-1 w-full text-xs">
        <thead>
          <tr className="border-b border-slate-200 text-left text-slate-500">
            <th className="py-1 pr-2">Task</th>
            <th className="py-1 pr-2">Model</th>
            <th className="py-1 pr-2 text-right">Calls</th>
            <th className="py-1 pr-2 text-right">Tokens / call (in · cached · out)</th>
            <th className="py-1 text-right">Cost</th>
          </tr>
        </thead>
        <tbody>
          {est.tasks.map((t) => (
            <tr key={t.task} className="border-b border-slate-100 last:border-0">
              <td className="py-1 pr-2">{TASK_META[t.task].label}</td>
              <td className="py-1 pr-2">{t.model ?? <span className="text-red-600">no model</span>}</td>
              <td className="py-1 pr-2 text-right tabular-nums">{t.calls}</td>
              <td className="py-1 pr-2 text-right tabular-nums" title={t.basis === 'history' ? 'Average of your recent calls' : 'Built-in assumption until there is usage history'}>
                {t.inputTokens.toLocaleString()} · {t.cachedTokens.toLocaleString()} · {t.outputTokens.toLocaleString()}
                <span className="ml-1 text-slate-400">({t.basis === 'history' ? 'history' : 'default'})</span>
              </td>
              <td className="py-1 text-right tabular-nums">{usd(t.costUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className={cx('text-xs', over ? 'text-red-600' : 'text-slate-500')}>
        This month: {usd(est.monthSpentUsd)} spent
        {est.monthlyBudgetUsd > 0 ? ` of ${usd(est.monthlyBudgetUsd)} budget` : ' (no budget cap)'}
        {over && ' — this run would go over the budget.'}
      </div>
    </div>
  );
}

export const DATE_FIELD_LABELS: Record<JobDateField, string> = { posted: 'Posted date', added: 'Date added' };

function Segmented<K extends string>({ options, value, onChange }: { options: { key: K; label: ReactNode; disabled?: boolean }[]; value: K; onChange: (k: K) => void }) {
  return (
    <div className="inline-flex overflow-hidden rounded-md border border-slate-300">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          disabled={o.disabled}
          onClick={() => onChange(o.key)}
          className={cx(
            'border-r border-slate-300 px-3 py-1.5 text-sm last:border-r-0 disabled:cursor-not-allowed disabled:opacity-50',
            value === o.key ? 'bg-indigo-600 text-white' : 'bg-white text-slate-700 hover:bg-slate-50',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Analysis controls for the Jobs screen: profiles, which jobs (a date range by posted date or date
 * added, or the jobs selected in the list), estimate, run progress and a preview of the results.
 * `children` render between the run status and the results preview (the job list).
 */
export default function AnalyzePanel({
  navigate,
  range,
  onRangeChange,
  dateField,
  onDateFieldChange,
  selectedJobIds,
  onPaste,
  refreshKey,
  children,
}: {
  navigate: Navigate;
  range: DateRange | null;
  onRangeChange: (r: DateRange) => void;
  dateField: JobDateField;
  onDateFieldChange: (f: JobDateField) => void;
  selectedJobIds: number[];
  onPaste: (j: JobListItem) => void;
  /** Changes whenever the job list is reloaded (links added, jobs deleted) so the estimate follows. */
  refreshKey: unknown;
  children?: ReactNode;
}) {
  const profiles = useIpc('profiles:list', {});
  const state = useIpc('analyze:state', {});
  const needsPaste = useIpc('jobs:needsPaste', {});
  const [selected, setSelected] = useState<Set<number> | null>(null);
  const [scope, setScope] = useState<'range' | 'selected'>('range');
  const [sourceKeys, setSourceKeys] = useState<string[] | null>(null); // null = all sources
  const [reanalyze, setReanalyze] = useState(false);
  const [est, setEst] = useState<AnalyzeEstimate | null>(null);
  const [estError, setEstError] = useState<string | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [estTick, setEstTick] = useState(0);
  const [run, setRun] = useState<AnalyzeProgress | null>(null);
  const [results, setResults] = useState<AnalysisRow[] | null>(null);
  const lastResultsLoad = useRef(0);
  const action = useAction();
  const confirm = useConfirm();

  const ready = useMemo(() => (profiles.data ?? []).filter((p) => p.activeParseStatus === 'done'), [profiles.data]);

  useEffect(() => {
    if (profiles.data && !selected) setSelected(new Set(ready.map((p) => p.id)));
  }, [profiles.data, ready, selected]);
  useEffect(() => {
    if (state.data) setRun(state.data.active ?? state.data.last);
  }, [state.data]);

  const bySelection = scope === 'selected';
  const params: AnalyzeParamsInput | null = useMemo(() => {
    if (!range || !selected || !selected.size) return null;
    if (bySelection && !selectedJobIds.length) return null;
    return {
      profileIds: [...selected],
      dateRange: range,
      dateField,
      sourceKeys: bySelection ? [] : (sourceKeys ?? []),
      reanalyze,
      jobIds: bySelection ? selectedJobIds : null,
    };
  }, [range, dateField, selected, sourceKeys, reanalyze, bySelection, selectedJobIds]);

  // Re-estimate (debounced) whenever the inputs change.
  useEffect(() => {
    if (!params) {
      setEst(null);
      return;
    }
    let stale = false;
    setEstimating(true);
    const t = setTimeout(async () => {
      try {
        const e = await invoke('analyze:estimate', params);
        if (!stale) {
          setEst(e);
          setEstError(null);
        }
      } catch (err) {
        if (!stale) setEstError((err as Error).message);
      } finally {
        if (!stale) setEstimating(false);
      }
    }, 250);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [params, estTick, refreshKey]);

  const loadResults = useCallback(async (runId: number) => {
    lastResultsLoad.current = Date.now();
    try {
      setResults(await invoke('analyze:results', { runId }));
    } catch {
      // keep the previous preview
    }
  }, []);
  const runId = run?.runId;
  const runStatus = run?.status;
  useEffect(() => {
    if (runId != null) void loadResults(runId);
  }, [runId, runStatus, loadResults]);

  useIpcEvent('analyze:progress', (p) => {
    setRun(p);
    if (p.status !== 'running') {
      void needsPaste.reload();
      setEstTick((t) => t + 1);
    } else if (Date.now() - lastResultsLoad.current > 3000) {
      void loadResults(p.runId);
    }
  });
  useIpcEvent('jobs:updated', () => {
    void needsPaste.reload();
    setEstTick((t) => t + 1);
  });

  const running = run?.status === 'running';

  const start = async () => {
    if (!params || !est) return;
    let override = false;
    if (est.exceedsBudget) {
      const ok = await confirm({
        title: 'This run goes over your monthly budget',
        message: (
          <>
            Estimated cost {usd(est.totalUsd)}. This month you've spent {usd(est.monthSpentUsd)} of your {usd(est.monthlyBudgetUsd)} budget, so this run would take you to about{' '}
            {usd(est.monthSpentUsd + est.totalUsd)}. Run it anyway?
          </>
        ),
        confirmLabel: 'Run anyway',
        danger: true,
      });
      if (!ok) return;
      override = true;
    }
    await action.run(async () => {
      await invoke('analyze:start', { params, budgetOverride: override });
    });
  };

  const toggleProfile = (id: number) => {
    const n = new Set(selected ?? []);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setSelected(n);
  };
  const allSourceKeys = est?.sources.map((s) => s.key) ?? [];
  const sourceChecked = (k: string) => sourceKeys == null || sourceKeys.includes(k);
  const toggleSource = (k: string) => {
    const cur = sourceKeys ?? allSourceKeys;
    const next = cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k];
    setSourceKeys(next.length === allSourceKeys.length && allSourceKeys.every((x) => next.includes(x)) ? null : next);
  };

  const notReady = (profiles.data ?? []).filter((p) => p.activeParseStatus !== 'done');
  const canRun = !!params && !!est && est.jobs > 0 && !est.profileProblems.length && !running && !action.busy && !estimating;

  return (
    <>
      <Card title="Analyze" actions={estimating ? <Spinner /> : null}>
        <p className="-mt-1 mb-3 text-xs text-slate-500">Fetch descriptions, extract job fields, apply your hard filters and score the jobs against your profiles.</p>
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <div>
            <div className="mb-1.5 text-sm font-medium text-slate-700">Profiles</div>
            {profiles.data && profiles.data.length === 0 ? (
              <p className="text-sm text-slate-500">
                No profiles yet.{' '}
                <button type="button" className="text-indigo-600 hover:underline" onClick={() => navigate('profiles')}>
                  Create one
                </button>{' '}
                and upload a resume first.
              </p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {ready.map((p) => (
                  <label key={p.id} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={selected?.has(p.id) ?? false} onChange={() => toggleProfile(p.id)} />
                    <span className="shrink-0 font-medium">{p.name}</span>
                    {p.headline && <span className="truncate text-xs text-slate-500">{p.headline}</span>}
                  </label>
                ))}
                {notReady.map((p) => (
                  <div key={p.id} className="flex items-center gap-2 text-sm text-slate-400" title="Upload a resume and let it finish parsing on the Profiles screen">
                    <input type="checkbox" disabled />
                    <span>{p.name}</span>
                    <span className="text-xs">
                      {p.activeParseStatus === 'parsing' || p.activeParseStatus === 'pending' ? 'resume is being parsed…' : p.activeResumeId ? 'resume parse failed' : 'no resume'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-slate-700">Jobs</span>
              <Segmented
                value={scope}
                onChange={setScope}
                options={[
                  { key: 'range', label: 'By date' },
                  { key: 'selected', label: `Selected in list (${selectedJobIds.length})` },
                ]}
              />
            </div>
            {bySelection ? (
              <p className="text-xs text-slate-500">
                {selectedJobIds.length
                  ? `Analyzes the ${plural(selectedJobIds.length, 'job')} selected in the list below, whatever their date. Closed jobs are skipped.`
                  : 'Select jobs in the list below (tick the checkboxes, or drag down them).'}
              </p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <Segmented
                    value={dateField}
                    onChange={onDateFieldChange}
                    options={(Object.keys(DATE_FIELD_LABELS) as JobDateField[]).map((k) => ({ key: k, label: DATE_FIELD_LABELS[k] }))}
                  />
                  {range && <DateRangePicker value={range} onChange={onRangeChange} />}
                </div>
                <p className="text-xs text-slate-500">
                  {dateField === 'posted'
                    ? 'Uses the posting date when known, otherwise the day the job was added.'
                    : 'Uses the day the job was added to the app (pasted or collected), whatever its posting date.'}{' '}
                  Closed jobs are skipped.
                </p>
                {est && est.sources.length > 0 && (
                  <details className="text-sm">
                    <summary className="cursor-pointer text-slate-600">
                      Sources: {sourceKeys == null ? `all ${est.sources.length}` : `${est.sources.filter((s) => sourceChecked(s.key)).length} of ${est.sources.length}`}
                    </summary>
                    <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
                      {est.sources.map((s) => (
                        <label key={s.key} className="flex items-center gap-1.5">
                          <input type="checkbox" checked={sourceChecked(s.key)} onChange={() => toggleSource(s.key)} />
                          {s.label} <span className="text-xs text-slate-400">{s.count}</span>
                        </label>
                      ))}
                    </div>
                  </details>
                )}
              </>
            )}
            <Toggle checked={reanalyze} onChange={setReanalyze} label="Re-analyze jobs already analyzed with the current resume, prompt and model" />
          </div>
        </div>

        <div className="mt-4 border-t border-slate-100 pt-3">
          <ErrorBox error={estError} />
          {selected && !selected.size && <p className="text-sm text-slate-500">Choose at least one profile.</p>}
          {est && params && (
            <>
              {est.profileProblems.map((p) => (
                <p key={p.profileId} className="mb-1 text-sm text-red-600">
                  {p.name}: {p.problem}
                </p>
              ))}
              {est.jobs === 0 ? (
                <p className="text-sm text-slate-500">{bySelection ? 'All selected jobs are closed.' : 'No open jobs in this date range from the chosen sources.'}</p>
              ) : (
                <EstimateView est={est} />
              )}
            </>
          )}
          <div className="mt-3 flex items-center gap-3">
            <Button variant="primary" disabled={!canRun} onClick={() => void start()}>
              {running ? 'Analyzing…' : est?.exceedsBudget ? 'Run (over budget)…' : 'Run analysis'}
            </Button>
            <ErrorBox error={action.error} />
          </div>
        </div>
      </Card>

      {run && (
        <RunPanel
          run={run}
          busy={action.busy}
          onCancel={() => void action.run(() => invoke('analyze:cancel', { runId: run.runId }))}
          onResume={() => void action.run(() => invoke('analyze:resume', { runId: run.runId }))}
        />
      )}

      {needsPaste.data && needsPaste.data.length > 0 && <NeedsPasteCard jobs={needsPaste.data} onPaste={onPaste} />}

      {children}

      {run && results && <ResultsPreview rows={results} onOpenResults={() => navigate('results')} />}
    </>
  );
}
