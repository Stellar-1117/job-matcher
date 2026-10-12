import { Fragment, useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react';
import { createColumnHelper, flexRender, getCoreRowModel, getSortedRowModel, useReactTable, type SortingState } from '@tanstack/react-table';
import type { AnalyzeProgress } from '@shared/analysis';
import { JOB_STATUSES, JOB_STATUS_LABELS, scoreRow, type JobStatus, type ResultsList } from '@shared/results';
import { DEFAULT_FILTERS, activeFilterCount, applyFilters, yearlySalary, type ResultFilters, type ScoredRow } from '@shared/resultFilters';
import { SUB_SCORE_KEYS, SUB_SCORE_LABELS, VERDICT_LABELS } from '@shared/scoring';
import { invoke, useIpc, useIpcEvent } from '../../api';
import { Badge, Button, ErrorBox, NumberInput, Select, Spinner, cx, useAction } from '../../components/ui';
import { useConfirm } from '../../components/confirm';
import { useRowSelection } from '../../hooks/useRowSelection';
import PostedDate from '../../components/PostedDate';
import type { Navigate } from '../../App';
import FilterSidebar from './FilterSidebar';
import ResultDetailPanel, { scoreColor } from './ResultDetailPanel';
import ExportDialog from './ExportDialog';
import { VERDICT_TONES, formatSalary, usd } from '../../components/format';

// Kept across visits to the screen (the screen unmounts when you navigate away).
let rememberedFilters: ResultFilters = DEFAULT_FILTERS;
let rememberedSorting: SortingState = [{ id: 'score', desc: true }];

const PROFILE_KEY = 'results.profileId';
function loadProfileId(): number | null {
  try {
    const v = Number(localStorage.getItem(PROFILE_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}
function saveProfileId(id: number): void {
  try {
    localStorage.setItem(PROFILE_KEY, String(id));
  } catch {
    // not persisted; fine
  }
}

const STATUS_TONES: Record<JobStatus, 'slate' | 'indigo' | 'blue' | 'green' | 'amber' | 'red'> = {
  new: 'indigo',
  reviewed: 'slate',
  selected: 'blue',
  exported: 'green',
  applied: 'green',
  rejected: 'red',
};

function MiniBars({ row }: { row: ScoredRow }) {
  if (!row.subScores) return <span className="text-xs text-slate-300">—</span>;
  return (
    <span className="flex h-5 items-end gap-0.5" title={SUB_SCORE_KEYS.map((k) => `${SUB_SCORE_LABELS[k]}: ${row.subScores![k]}`).join('\n')}>
      {SUB_SCORE_KEYS.map((k) => (
        <span key={k} className="flex h-5 w-1.5 items-end rounded-sm bg-slate-100">
          <span className={cx('w-full rounded-sm', scoreColor(row.subScores![k]))} style={{ height: `${Math.max(8, row.subScores![k])}%` }} />
        </span>
      ))}
    </span>
  );
}

const col = createColumnHelper<ScoredRow>();

export default function ResultsScreen({ navigate }: { navigate: Navigate }) {
  const profiles = useIpc('profiles:list', {});
  const settings = useIpc('settings:get', {});
  const [profileId, setProfileId] = useState<number | null>(loadProfileId);
  const [list, setList] = useState<ResultsList | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filters, setFiltersState] = useState<ResultFilters>(rememberedFilters);
  const [sorting, setSortingState] = useState<SortingState>(rememberedSorting);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [threshold, setThreshold] = useState(70);
  const [bulkStatus, setBulkStatus] = useState<JobStatus>('selected');
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState<AnalyzeProgress | null>(null);
  const [showFilters, setShowFilters] = useState(true);
  const action = useAction();
  const confirm = useConfirm();

  const setFilters = (f: ResultFilters) => {
    rememberedFilters = f;
    setFiltersState(f);
  };
  const setSorting = (u: SortingState | ((old: SortingState) => SortingState)) => {
    setSortingState((old) => {
      const next = typeof u === 'function' ? u(old) : u;
      rememberedSorting = next;
      return next;
    });
  };

  // Pick a profile: the remembered one if it still exists, else the first.
  useEffect(() => {
    if (!profiles.data?.length) return;
    if (profileId == null || !profiles.data.some((p) => p.id === profileId)) setProfileId(profiles.data[0].id);
  }, [profiles.data, profileId]);

  const load = useCallback(async (pid: number) => {
    setLoading(true);
    try {
      setList(await invoke('results:list', { profileId: pid }));
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (profileId == null) return;
    saveProfileId(profileId);
    setExpanded(new Set());
    void load(profileId);
  }, [profileId, load]);

  useEffect(() => {
    void invoke('analyze:state', {}).then((s) => setAnalyzing(s.active));
  }, []);
  useIpcEvent('analyze:progress', (p) => {
    setAnalyzing(p.status === 'running' ? p : null);
    if (p.status !== 'running' && profileId != null) void load(profileId);
  });

  const s = settings.data;
  // Totals and verdicts come from the stored sub-scores and the current weights — no LLM involved.
  const scored = useMemo<ScoredRow[]>(() => (list && s ? list.rows.map((r) => ({ ...r, ...scoreRow(r, s.weights, s.thresholds) })) : []), [list, s]);
  const visible = useMemo(() => applyFilters(scored, filters), [scored, filters]);
  const profileName = profiles.data?.find((p) => p.id === profileId)?.name ?? '';

  const patchRows = (ids: number[], patch: Partial<ScoredRow>) => {
    const set = new Set(ids);
    setList((l) => (l ? { ...l, rows: l.rows.map((r) => (set.has(r.jobId) ? { ...r, ...patch } : r)) } : l));
  };

  const columns = useMemo(
    () => [
      col.display({ id: 'select', enableSorting: false, meta: { className: 'w-8' } }),
      // Score and verdict share a cell: the verdict follows from the score, so one sort covers both.
      col.accessor((r) => (r.hardFilterPass ? (r.total ?? (r.preScore != null ? -1 : -2)) : -3), { id: 'score', header: 'Score', sortDescFirst: true, meta: { className: 'w-[4.75rem]' } }),
      col.accessor((r) => (r.title ?? '').toLowerCase(), { id: 'title', header: 'Title', sortingFn: 'alphanumeric', meta: { className: '' } }),
      col.accessor((r) => (r.companyName ?? '').toLowerCase(), { id: 'company', header: 'Company', sortingFn: 'alphanumeric', meta: { className: 'w-28' } }),
      col.accessor((r) => `${r.fields?.work_mode ?? ''} ${r.location ?? ''}`.toLowerCase(), { id: 'location', header: 'Location', sortingFn: 'alphanumeric', meta: { className: 'w-28' } }),
      col.accessor((r) => yearlySalary(r.fields) ?? -1, { id: 'salary', header: 'Salary', sortDescFirst: true, meta: { className: 'w-[6.5rem]' } }),
      col.accessor((r) => Date.parse(r.postedAt ?? r.firstSeenAt), { id: 'posted', header: 'Posted', sortDescFirst: true, meta: { className: 'w-32' } }),
      // Shown under the posted date (to leave room for titles); sorted from that column's header.
      col.accessor((r) => r.sourceLabel.toLowerCase(), { id: 'source', header: 'Source', sortingFn: 'alphanumeric' }),
      col.accessor((r) => JOB_STATUSES.indexOf(r.status), { id: 'status', header: 'Status', meta: { className: 'w-[5.5rem]' } }),
      col.display({ id: 'bars', header: 'Sub-scores', enableSorting: false, meta: { className: 'w-[4.5rem]' } }),
    ],
    [],
  );

  const table = useReactTable({
    data: visible,
    columns,
    state: { sorting, columnVisibility: { source: false } },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (r) => String(r.jobId),
  });
  const orderedRows = table.getRowModel().rows.map((r) => r.original);
  const orderedIds = orderedRows.map((r) => r.jobId);
  const sel = useRowSelection(orderedIds);
  const selectedRows = orderedRows.filter((r) => sel.selected.has(r.jobId));
  // Selected rows hidden by a filter still count; keep the table order for what's visible.
  const selectedAll = scored.filter((r) => sel.selected.has(r.jobId));
  const selectedIds = [...selectedRows.map((r) => r.jobId), ...selectedAll.filter((r) => !orderedIds.includes(r.jobId)).map((r) => r.jobId)];
  const allVisibleSelected = orderedIds.length > 0 && orderedIds.every((id) => sel.selected.has(id));

  const toggleExpand = (row: ScoredRow) => {
    const open = !expanded.has(row.jobId);
    setExpanded((e) => {
      const n = new Set(e);
      if (open) n.add(row.jobId);
      else n.delete(row.jobId);
      return n;
    });
    // Opening a row marks it reviewed for this profile only.
    if (open && row.status === 'new' && profileId != null) {
      patchRows([row.jobId], { status: 'reviewed' });
      void invoke('results:open', { profileId, jobId: row.jobId }).catch(() => {});
    }
  };

  const setStatus = (ids: number[], status: JobStatus) =>
    action.run(async () => {
      if (profileId == null || !ids.length) return;
      await invoke('results:setStatus', { profileId, jobIds: ids, status });
      patchRows(ids, { status });
    });

  const reanalyze = (ids: number[]) =>
    action.run(async () => {
      if (profileId == null || !ids.length) return;
      const params = { profileIds: [profileId], dateRange: { preset: 'last30' as const, from: null, to: null }, sourceKeys: [], reanalyze: true, jobIds: ids };
      const est = await invoke('analyze:estimate', params);
      const ok = await confirm({
        title: `Re-analyze ${ids.length} job${ids.length === 1 ? '' : 's'} for ${profileName}?`,
        message: (
          <>
            About {usd(est.totalUsd)} ({est.needMatching} matching call{est.needMatching === 1 ? '' : 's'}
            {est.needExtraction ? `, ${est.needExtraction} extraction${est.needExtraction === 1 ? '' : 's'}` : ''}).
            {est.hardFiltered > 0 && ` ${est.hardFiltered} fail your hard filters and won't be sent.`}
            {est.exceedsBudget && <span className="font-medium text-red-600"> This goes over your monthly budget.</span>}
          </>
        ),
        confirmLabel: est.exceedsBudget ? 'Re-analyze anyway' : 'Re-analyze',
        danger: est.exceedsBudget,
      });
      if (!ok) return;
      await invoke('analyze:start', { params, budgetOverride: est.exceedsBudget });
      setNotice(`Re-analyzing ${ids.length} job${ids.length === 1 ? '' : 's'}… results refresh when it finishes.`);
    });

  const feedback = (row: ScoredRow, fb: -1 | 0 | 1, note: string | null) =>
    action.run(async () => {
      if (profileId == null) return;
      await invoke('results:feedback', { profileId, jobId: row.jobId, feedback: fb, note });
      patchRows([row.jobId], { feedback: fb, feedbackNote: note });
    });

  const onRowClick = (e: MouseEvent, row: ScoredRow, rowClick: (e: MouseEvent) => void) => {
    rowClick(e); // Ctrl/Cmd-click toggles selection
    if (e.ctrlKey || e.metaKey || e.shiftKey) return;
    if ((e.target as HTMLElement).closest('a,button,input,select,textarea,label,[data-select-cell]')) return;
    toggleExpand(row);
  };

  if (profiles.data && profiles.data.length === 0) {
    return (
      <div className="p-8">
        <h1 className="text-xl font-semibold">Results</h1>
        <p className="mt-2 text-slate-500">
          No profiles yet.{' '}
          <button type="button" className="text-indigo-600 hover:underline" onClick={() => navigate('profiles')}>
            Create a profile
          </button>{' '}
          and run an analysis first.
        </p>
      </div>
    );
  }

  const exportedSelected = selectedAll.filter((r) => r.exportedAt).length;
  // "Different model" warning (§12): analyses made with another matching model or prompt than the current route.
  const isStale = (r: ScoredRow) =>
    r.outcome === 'matched' &&
    ((list?.currentModelId != null && r.modelId !== list.currentModelId) || (list?.currentPromptVersion != null && r.promptVersion != null && r.promptVersion !== list.currentPromptVersion));
  const staleVisible = orderedRows.filter(isStale);

  return (
    <div className="flex h-full min-h-0">
      {list && showFilters && <FilterSidebar rows={scored} filters={filters} onChange={setFilters} />}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Header */}
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-5 py-3">
          <Button size="sm" variant="ghost" onClick={() => setShowFilters((v) => !v)} title={showFilters ? 'Hide the filter panel for a wider table' : 'Show filters'}>
            {showFilters ? '◂ Filters' : '▸ Filters'}
            {!showFilters && activeFilterCount(filters) > 0 && <Badge tone="indigo">{activeFilterCount(filters)}</Badge>}
          </Button>
          <h1 className="text-xl font-semibold">Results</h1>
          <label className="flex items-center gap-1.5 text-sm text-slate-600">
            Profile
            <Select value={profileId ?? ''} onChange={(e) => setProfileId(Number(e.target.value))} className="min-w-40 font-medium">
              {(profiles.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </label>
          {loading && <Spinner />}
          <span className="text-sm text-slate-500">
            {visible.length} of {scored.length} shown
          </span>
          <span className="ml-auto text-xs text-slate-400" title="Change weights and thresholds in Settings → General; scores update instantly">
            Scores use your current weights
          </span>
        </div>

        {staleVisible.length > 0 && !analyzing && (
          <div className="flex items-center gap-2 border-b border-amber-100 bg-amber-50 px-5 py-1.5 text-sm text-amber-800">
            ⚠ {staleVisible.length} result{staleVisible.length === 1 ? ' was' : 's were'} scored with a different matching model or prompt than the current one
            {list?.currentModelName ? ` (${list.currentModelName}, prompt v${list.currentPromptVersion ?? '?'})` : ''}, so scores may not be comparable.
            <button type="button" className="ml-auto text-xs font-medium underline" onClick={() => sel.setMany(staleVisible.map((r) => r.jobId), true)}>
              Select them
            </button>
          </div>
        )}
        {analyzing && (
          <div className="flex items-center gap-2 border-b border-indigo-100 bg-indigo-50 px-5 py-1.5 text-sm text-indigo-800">
            <Spinner /> Analysis running: {analyzing.matches.finished}/{analyzing.matches.total} matches · {usd(analyzing.costUsd)} so far. Results refresh when it finishes.
            <button type="button" className="ml-auto text-xs underline" onClick={() => navigate('jobs')}>
              Open Jobs & Analyze
            </button>
          </div>
        )}

        {/* Selection & bulk actions */}
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-5 py-2 text-sm">
          <span className="min-w-24 font-medium text-slate-800">{selectedIds.length} selected</span>
          <Button size="sm" variant="ghost" disabled={!orderedIds.length} onClick={() => sel.setMany(orderedIds, true)}>
            Select all visible
          </Button>
          <span className="flex items-center gap-1">
            <Button size="sm" variant="ghost" onClick={() => sel.setMany(orderedRows.filter((r) => r.total != null && r.total >= threshold).map((r) => r.jobId), true)}>
              Select score ≥
            </Button>
            <NumberInput value={threshold} min={0} max={100} onCommit={(v) => setThreshold(Math.max(0, Math.min(100, Math.round(v))))} className="w-16 py-0.5 text-xs" />
          </span>
          <Button size="sm" variant="ghost" disabled={!selectedIds.length} onClick={sel.clear}>
            Clear selection
          </Button>
          <span className="mx-1 h-5 w-px bg-slate-200" />
          <Select value={bulkStatus} onChange={(e) => setBulkStatus(e.target.value as JobStatus)} className="py-0.5 text-xs">
            {JOB_STATUSES.map((st) => (
              <option key={st} value={st}>
                {JOB_STATUS_LABELS[st]}
              </option>
            ))}
          </Select>
          <Button size="sm" disabled={!selectedIds.length || action.busy} onClick={() => void setStatus(selectedIds, bulkStatus)}>
            Set status
          </Button>
          <Button size="sm" disabled={!selectedIds.length || action.busy || !!analyzing} onClick={() => void reanalyze(selectedIds)}>
            Re-analyze
          </Button>
          <Button size="sm" variant="primary" disabled={!selectedIds.length} onClick={() => setExporting(true)}>
            Export…
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-3">
          <ErrorBox error={loadError ?? action.error} />
          {notice && (
            <div className="mb-2 flex items-center rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-sm text-emerald-800">
              {notice}
              <button type="button" className="ml-auto text-xs text-emerald-700 hover:underline" onClick={() => setNotice(null)}>
                Dismiss
              </button>
            </div>
          )}
          {list && scored.length === 0 && (
            <p className="py-10 text-center text-sm text-slate-500">
              No analyzed jobs for {profileName} yet.{' '}
              <button type="button" className="text-indigo-600 hover:underline" onClick={() => navigate('jobs')}>
                Run an analysis
              </button>
              .
            </p>
          )}
          {scored.length > 0 && (
            <>
              <p className="mb-2 text-xs text-slate-500">
                Click a row for details (marks it reviewed) · drag down the checkboxes to select a run · Shift-click for a range · Ctrl-click a row to toggle it.
              </p>
              <table className="w-full min-w-[880px] table-fixed border-separate border-spacing-0 text-sm">
                <thead className="sticky top-0 z-10 bg-slate-50">
                  {table.getHeaderGroups().map((hg) => (
                    <tr key={hg.id}>
                      {hg.headers.map((h) => {
                        const meta = h.column.columnDef.meta as { className?: string } | undefined;
                        const sorted = h.column.getIsSorted();
                        return (
                          <th key={h.id} className={cx('border-b border-slate-200 p-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500', meta?.className)}>
                            {h.column.id === 'select' ? (
                              <input type="checkbox" checked={allVisibleSelected} onChange={() => sel.setMany(orderedIds, !allVisibleSelected)} title="Select all visible" />
                            ) : h.column.id === 'posted' ? (
                              <span className="flex items-center gap-1">
                                {(['posted', 'source'] as const).map((id, i) => {
                                  const c = table.getColumn(id)!;
                                  const sd = c.getIsSorted();
                                  return (
                                    <Fragment key={id}>
                                      {i > 0 && <span className="text-slate-300">·</span>}
                                      <button type="button" className="flex items-center gap-0.5 uppercase hover:text-slate-800" onClick={c.getToggleSortingHandler()}>
                                        {id === 'posted' ? 'Posted' : 'Source'}
                                        <span className="text-slate-400">{sd === 'asc' ? '▲' : sd === 'desc' ? '▼' : ''}</span>
                                      </button>
                                    </Fragment>
                                  );
                                })}
                              </span>
                            ) : h.column.getCanSort() ? (
                              <button type="button" className="flex items-center gap-1 uppercase hover:text-slate-800" onClick={h.column.getToggleSortingHandler()}>
                                {flexRender(h.column.columnDef.header, h.getContext())}
                                <span className="text-slate-400">{sorted === 'asc' ? '▲' : sorted === 'desc' ? '▼' : ''}</span>
                              </button>
                            ) : (
                              flexRender(h.column.columnDef.header, h.getContext())
                            )}
                          </th>
                        );
                      })}
                    </tr>
                  ))}
                </thead>
                <tbody>
                  {table.getRowModel().rows.map((tr) => {
                    const r = tr.original;
                    const selected = sel.isSelected(r.jobId);
                    const isOpen = expanded.has(r.jobId);
                    const rp = sel.rowProps(r.jobId);
                    const f = r.fields;
                    return (
                      <Fragment key={r.jobId}>
                        <tr
                          className={cx('cursor-pointer align-top hover:bg-slate-50', selected && 'bg-indigo-50/70', isOpen && 'bg-indigo-50/40', r.isClosed && 'opacity-60')}
                          onMouseEnter={rp.onMouseEnter}
                          onClick={(e) => onRowClick(e, r, rp.onClick)}
                        >
                          <td data-select-cell className="border-b border-slate-100 py-2 pl-2" {...sel.handleProps(r.jobId)}>
                            <input type="checkbox" readOnly checked={selected} className="pointer-events-none mt-0.5" />
                          </td>
                          <td className="border-b border-slate-100 p-2">
                            {!r.hardFilterPass ? (
                              <span title={r.hardFilterReasons.join('\n')}>
                                <Badge tone="red">Filtered</Badge>
                              </span>
                            ) : r.total != null ? (
                              <span className="text-base font-semibold tabular-nums">{r.total}</span>
                            ) : r.preScore != null ? (
                              <span className="text-xs text-slate-500" title="Skipped by the quick pre-score">
                                pre {r.preScore}
                              </span>
                            ) : (
                              <span className="text-slate-300">—</span>
                            )}
                            {r.hardFilterPass && r.verdict && (
                              <div className="mt-0.5">
                                <Badge tone={VERDICT_TONES[r.verdict]}>{VERDICT_LABELS[r.verdict]}</Badge>
                              </div>
                            )}
                          </td>
                          <td className="min-w-0 border-b border-slate-100 p-2">
                            <div className="flex items-start gap-1.5">
                              <span className="mt-0.5 w-3 shrink-0 text-xs text-slate-400">{isOpen ? '▾' : '▸'}</span>
                              <a href={r.url} target="_blank" rel="noreferrer" className="line-clamp-2 font-medium text-indigo-700 hover:underline" title={`${r.title ?? ''}\n${r.url}`}>
                                {r.title ?? r.url}
                              </a>
                              {isStale(r) && (
                                <span className="shrink-0 text-amber-600" title={`Scored with ${r.modelName ?? 'another model'} / prompt v${r.promptVersion ?? '?'}; matching now uses ${list?.currentModelName ?? '?'} / v${list?.currentPromptVersion ?? '?'}. Re-analyze to compare like with like.`}>
                                  ⚠
                                </span>
                              )}
                              {r.feedback === 1 && <span title="You liked this match">👍</span>}
                              {r.feedback === -1 && <span title="You disliked this match">👎</span>}
                            </div>
                            {r.summary && (
                              <div className="truncate pl-4 text-xs text-slate-500" title={r.summary}>
                                {r.summary}
                              </div>
                            )}
                            {!r.hardFilterPass && <div className="truncate pl-4 text-xs text-red-600">{r.hardFilterReasons.join('; ')}</div>}
                          </td>
                          <td className="truncate border-b border-slate-100 p-2 text-slate-700" title={r.companyName ?? ''}>
                            {r.companyName}
                          </td>
                          <td className="border-b border-slate-100 p-2">
                            <div className="truncate text-xs text-slate-700" title={r.location ?? ''}>
                              {r.location ?? ([f?.city, f?.country].filter(Boolean).join(', ') || '—')}
                            </div>
                            {f?.work_mode && f.work_mode !== 'Unknown' && <Badge tone={f.work_mode === 'Remote' ? 'green' : 'slate'}>{f.work_mode}</Badge>}
                          </td>
                          <td className={cx('border-b border-slate-100 p-2 text-xs', f?.salary_listed ? 'text-slate-700' : 'text-slate-400')}>{formatSalary(f)}</td>
                          <td className="border-b border-slate-100 p-2 text-xs tabular-nums text-slate-600">
                            <PostedDate job={r} />
                            <div className="truncate text-slate-500" title={r.sourceLabel}>
                              {r.sourceLabel}
                            </div>
                          </td>
                          <td className="border-b border-slate-100 p-2">
                            <span title={r.exportedAt ? `Exported ${new Date(r.exportedAt).toLocaleString()}` : undefined}>
                              <Badge tone={STATUS_TONES[r.status]}>{JOB_STATUS_LABELS[r.status]}</Badge>
                            </span>
                          </td>
                          <td className="border-b border-slate-100 p-2">
                            <MiniBars row={r} />
                          </td>
                        </tr>
                        {isOpen && list && s && (
                          <tr>
                            <td colSpan={table.getVisibleLeafColumns().length} className="border-b border-slate-200 p-0">
                              <ResultDetailPanel
                                key={`${r.analysisId}-${r.analyzedAt}`}
                                row={r}
                                list={list}
                                weights={s.weights}
                                feedbackEnabled={s.feedbackEnabled}
                                onStatus={(st) => void setStatus([r.jobId], st)}
                                onReanalyze={() => void reanalyze([r.jobId])}
                                onFeedback={(fb, note) => void feedback(r, fb, note)}
                              />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
              {visible.length === 0 && <p className="py-8 text-center text-sm text-slate-500">No jobs match these filters.</p>}
            </>
          )}
        </div>
      </div>

      {exporting && profileId != null && (
        <ExportDialog
          profileId={profileId}
          profileName={profileName}
          jobIds={selectedIds}
          alreadyExported={exportedSelected}
          onClose={() => setExporting(false)}
          onDone={(ids, msg) => {
            setExporting(false);
            setNotice(msg);
            patchRows(ids, { status: 'exported', exportedAt: new Date().toISOString() });
          }}
        />
      )}
    </div>
  );
}
