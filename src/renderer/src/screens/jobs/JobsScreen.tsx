import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { FETCH_STATUSES, FETCH_STATUS_LABELS, type AddLinksResult, type JobListItem, type JobProfileAnalysis } from '@shared/jobs';
import { jobInDateRange, resolveDateRange, type JobDateField } from '@shared/dates';
import type { DateRange } from '@shared/settings';
import { invoke, useIpc, useIpcEvent } from '../../api';
import { Badge, Button, Card, ErrorBox, Input, JobLink, Select, Textarea, cx, useAction } from '../../components/ui';
import { useConfirm } from '../../components/confirm';
import { useRowSelection } from '../../hooks/useRowSelection';
import PasteDialog from '../../components/PasteDialog';
import PostedDate, { jobDate } from '../../components/PostedDate';
import type { Navigate } from '../../App';
import { VERDICT_TONES } from '../../components/format';
import AnalyzePanel, { DATE_FIELD_LABELS } from './AnalyzePanel';

type GroupBy = 'source' | 'company' | 'date' | 'posted' | 'status' | 'profiles' | 'none';
/** 'all' | 'none' (not analyzed for any profile) | 'in:<profileId>' | 'out:<profileId>' */
type ProfileFilter = string;
type SortBy = 'posted' | 'newest' | 'oldest' | 'company' | 'title' | 'url';

const GROUP_LABELS: Record<GroupBy, string> = {
  source: 'Source',
  company: 'Company',
  date: 'Date added',
  posted: 'Date posted',
  status: 'Status',
  profiles: 'Analyzed profiles',
  none: 'No grouping',
};

const SORT_LABELS: Record<SortBy, string> = {
  posted: 'Newest posted',
  newest: 'Newest added',
  oldest: 'Oldest added',
  company: 'Company A–Z',
  title: 'Title A–Z',
  url: 'URL A–Z',
};

const STATUS_TONES: Record<string, 'slate' | 'green' | 'amber' | 'blue'> = {
  pending: 'slate',
  fetched: 'green',
  unreadable: 'amber',
  manual_text: 'blue',
};

function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dayLabel(key: string): string {
  const today = dayKey(new Date().toISOString());
  const y = new Date();
  y.setDate(y.getDate() - 1);
  if (key === today) return 'Today';
  if (key === dayKey(y.toISOString())) return 'Yesterday';
  const [yy, mm, dd] = key.split('-').map(Number);
  return new Date(yy, mm - 1, dd).toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
}

/** Short readable form of a URL for display: host + path. */
function displayUrl(url: string): string {
  return url.replace(/^https:\/\//, '');
}

interface Group {
  key: string;
  label: string;
  items: JobListItem[];
}

function sortItems(items: JobListItem[], sort: SortBy): JobListItem[] {
  const cmpText = (a: string | null, b: string | null) => {
    if (!a && !b) return 0;
    if (!a) return 1; // unknowns last
    if (!b) return -1;
    return a.localeCompare(b, undefined, { sensitivity: 'base' });
  };
  const out = [...items];
  out.sort((a, b) => {
    switch (sort) {
      case 'posted':
        return jobDate(b).localeCompare(jobDate(a)) || b.id - a.id;
      case 'newest':
        return b.firstSeenAt.localeCompare(a.firstSeenAt) || b.id - a.id;
      case 'oldest':
        return a.firstSeenAt.localeCompare(b.firstSeenAt) || a.id - b.id;
      case 'company':
        return cmpText(a.companyName, b.companyName) || cmpText(a.title, b.title) || cmpText(a.url, b.url);
      case 'title':
        return cmpText(a.title, b.title) || cmpText(a.url, b.url);
      case 'url':
        return cmpText(a.url, b.url);
    }
  });
  return out;
}

function groupItems(items: JobListItem[], by: GroupBy): Group[] {
  if (by === 'none') return [{ key: 'all', label: 'All jobs', items }];
  const map = new Map<string, Group>();
  for (const it of items) {
    let key: string;
    let label: string;
    switch (by) {
      case 'source':
        key = it.sourceLabel;
        label = it.sourceLabel;
        break;
      case 'company':
        key = it.companyName?.toLowerCase() ?? '';
        label = it.companyName ?? 'Unknown company';
        break;
      case 'date':
        key = dayKey(it.firstSeenAt);
        label = dayLabel(key);
        break;
      case 'posted':
        key = dayKey(jobDate(it));
        label = dayLabel(key);
        break;
      case 'status':
        key = it.isClosed ? 'closed' : it.fetchStatus;
        label = it.isClosed ? 'Closed' : FETCH_STATUS_LABELS[it.fetchStatus];
        break;
      case 'profiles': {
        const names = it.analyses.map((a) => a.profileName);
        key = names.map((n) => n.toLowerCase()).join('\u0000');
        label = names.length ? `Analyzed for ${names.join(', ')}` : 'Not analyzed yet';
        break;
      }
    }
    const g = map.get(key) ?? { key, label, items: [] };
    g.items.push(it);
    map.set(key, g);
  }
  const groups = [...map.values()];
  switch (by) {
    case 'source':
      return groups.sort((a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label));
    case 'company':
      return groups.sort((a, b) => (a.key === '' ? 1 : b.key === '' ? -1 : a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })));
    case 'date':
    case 'posted':
      return groups.sort((a, b) => b.key.localeCompare(a.key));
    case 'status': {
      const order = [...FETCH_STATUSES, 'closed'] as string[];
      return groups.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
    }
    case 'profiles': {
      // Most profiles first; "not analyzed" last.
      const count = (g: Group) => g.items[0].analyses.length;
      return groups.sort((a, b) => (count(a) === 0 ? 1 : count(b) === 0 ? -1 : count(b) - count(a) || a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })));
    }
  }
}

function AddLinksCard({ onAdded }: { onAdded: (r: AddLinksResult) => void }) {
  const [text, setText] = useState('');
  const [result, setResult] = useState<AddLinksResult | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const action = useAction();
  const lineCount = text.split('\n').filter((l) => l.trim()).length;

  const save = () =>
    action.run(async () => {
      const r = await invoke('jobs:addLinks', { text });
      setResult(r);
      setShowDetails(r.invalid.length > 0);
      setText('');
      onAdded(r);
    });

  return (
    <Card title="Add job links">
      <Textarea
        rows={5}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={'Paste job links, one per line (LinkedIn, Jobright, Welcome to the Jungle, Greenhouse, Lever, Ashby, Workday, company sites…)'}
        className="font-mono text-xs"
      />
      <div className="mt-2 flex items-center gap-3">
        <Button variant="primary" disabled={action.busy || !text.trim()} onClick={save}>
          {action.busy ? 'Saving…' : `Save ${lineCount ? lineCount : ''} link${lineCount === 1 ? '' : 's'}`}
        </Button>
        <span className="text-xs text-slate-500">
          Tracking parameters are removed. Links you already have aren't saved twice — they're marked <b>added again</b> with the rest of this paste, so the whole paste can be
          analyzed for another profile.
        </span>
      </div>
      <div className="mt-2">
        <ErrorBox error={action.error} />
      </div>
      {result && (
        <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">
          <div className="flex flex-wrap items-center gap-3">
            <span className={cx('font-medium', result.added.length ? 'text-emerald-700' : 'text-slate-600')}>
              {result.added.length ? '✓ ' : ''}
              {result.added.length} added
            </span>
            <span className="text-slate-600">
              {result.duplicates.length} already saved{result.duplicates.length ? ' (marked “added again”)' : ''}
            </span>
            {result.invalid.length > 0 && <span className="text-red-600">{result.invalid.length} not a link</span>}
            {(result.duplicates.length > 0 || result.invalid.length > 0) && (
              <button type="button" className="text-xs text-indigo-600 hover:underline" onClick={() => setShowDetails((v) => !v)}>
                {showDetails ? 'Hide details' : 'Show details'}
              </button>
            )}
          </div>
          {showDetails && (
            <div className="mt-2 max-h-48 overflow-auto font-mono text-xs">
              {result.duplicates.map((d, i) => (
                <div key={`d${i}`} className="text-slate-600">
                  <span className="text-slate-400">dup</span> {d.input}
                  {d.reason === 'repeated_in_paste' ? ' — repeated in this paste' : d.reason === 'same_job' ? ' — same posting as a saved job (link added to it)' : ` — already saved as ${displayUrl(d.url)}`}
                </div>
              ))}
              {result.invalid.map((d, i) => (
                <div key={`i${i}`} className="text-red-600">
                  <span className="text-red-400">bad</span> {d.input} — {d.reason}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

export function ProfileBadge({ a }: { a: JobProfileAnalysis }) {
  const what = a.status === 'scored' ? `score ${a.score}` : a.status === 'filtered' ? 'failed a hard filter' : 'skipped by the pre-score';
  return (
    <span title={`Analyzed for ${a.profileName}: ${what}`}>
      <Badge tone={a.verdict ? VERDICT_TONES[a.verdict] : 'slate'}>
        {a.profileName}
        {a.status === 'scored' ? <span className="ml-1 tabular-nums opacity-80">{a.score}</span> : <span className="ml-1 font-normal opacity-70">{a.status}</span>}
      </Badge>
    </span>
  );
}

type RowSelection = ReturnType<typeof useRowSelection>;

/** Memoized: with stable callbacks, a selection change re-renders only the rows whose `selected` flips. */
const JobRow = memo(function JobRow({
  job,
  selected,
  handleProps,
  rowProps,
  batch,
  onDelete,
  onPaste,
}: {
  job: JobListItem;
  selected: boolean;
  handleProps: RowSelection['handleProps'];
  rowProps: RowSelection['rowProps'];
  /** In the latest paste: newly saved, or already saved before. */
  batch: 'new' | 'again' | null;
  onDelete: (id: number) => void;
  onPaste: (job: JobListItem) => void;
}) {
  return (
    <tr className={cx('group border-b border-slate-100 last:border-0 hover:bg-slate-50', selected && 'bg-indigo-50/60')} {...rowProps(job.id)}>
      <td className="w-10 py-2 pl-3 align-top" {...handleProps(job.id)}>
        <input type="checkbox" readOnly checked={selected} className="pointer-events-none mt-1" />
      </td>
      <td className="min-w-0 py-2 pr-3 align-top">
        <div className="flex items-center gap-2">
          <JobLink href={job.url} className="truncate font-medium text-indigo-700 hover:underline" title={job.url ?? 'Saved from its description (no link)'}>
            {job.title ?? (job.url ? displayUrl(job.url) : 'Untitled description')}
          </JobLink>
          {batch === 'new' && <Badge tone="green">new</Badge>}
          {batch === 'again' && (
            <span title="Already saved before — part of your latest paste">
              <Badge tone="blue">added again</Badge>
            </span>
          )}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-slate-500">
          {job.companyName && <span className="shrink-0 font-medium text-slate-600">{job.companyName}</span>}
          {job.location && <span className="max-w-64 shrink-0 truncate" title={job.location}>{job.location}</span>}
          {job.title && job.url && (
            <span className="truncate font-mono" title={job.url}>
              {displayUrl(job.url)}
            </span>
          )}
          {job.extraUrls.length > 0 && (
            <span className="shrink-0 text-slate-400" title={job.extraUrls.join('\n')}>
              +{job.extraUrls.length} alt link{job.extraUrls.length === 1 ? '' : 's'}
            </span>
          )}
        </div>
        {job.analyses.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {job.analyses.map((a) => (
              <ProfileBadge key={a.profileId} a={a} />
            ))}
          </div>
        )}
      </td>
      <td className="w-40 py-2 pr-3 align-top">
        <Badge tone="indigo">{job.sourceLabel}</Badge>
      </td>
      <td className="w-36 py-2 pr-3 align-top">
        {job.fetchStatus === 'unreadable' && !job.isClosed ? (
          <button type="button" onClick={() => onPaste(job)} title={`${job.fetchError ?? ''}
Click to paste the description`} className="rounded hover:ring-2 hover:ring-amber-300">
            <Badge tone="amber">{FETCH_STATUS_LABELS.unreadable}</Badge>
          </button>
        ) : (
          <span title={job.isClosed ? job.closedReason ?? 'Closed' : undefined}>
            <Badge tone={job.isClosed ? 'red' : STATUS_TONES[job.fetchStatus]}>{job.isClosed ? 'Closed' : FETCH_STATUS_LABELS[job.fetchStatus]}</Badge>
          </span>
        )}
      </td>
      <td className="w-32 py-2 pr-3 align-top text-xs tabular-nums text-slate-500">
        <PostedDate job={job} />
      </td>
      <td className="w-16 py-2 pr-3 text-right align-top">
        <button type="button" onClick={() => onDelete(job.id)} className="invisible text-xs text-red-600 hover:underline group-hover:visible">
          Delete
        </button>
      </td>
    </tr>
  );
});

function Pager({ page, pageCount, onPage }: { page: number; pageCount: number; onPage: (p: number) => void }) {
  if (pageCount <= 1) return null;
  return (
    <div className="flex items-center gap-1 text-sm text-slate-600">
      <Button size="sm" variant="ghost" disabled={page === 0} onClick={() => onPage(0)} title="First page">
        «
      </Button>
      <Button size="sm" variant="ghost" disabled={page === 0} onClick={() => onPage(page - 1)}>
        ‹ Prev
      </Button>
      <span className="px-1 tabular-nums">
        Page {page + 1} of {pageCount}
      </span>
      <Button size="sm" variant="ghost" disabled={page >= pageCount - 1} onClick={() => onPage(page + 1)}>
        Next ›
      </Button>
      <Button size="sm" variant="ghost" disabled={page >= pageCount - 1} onClick={() => onPage(pageCount - 1)} title="Last page">
        »
      </Button>
    </div>
  );
}

const PAGE_SIZES = [50, 100, 200, 500];

/** One unit of pagination: a row of an expanded group, or the header of a collapsed group (job null). */
interface Line {
  group: Group;
  job: JobListItem | null;
}

/** Consecutive lines of one group on the current page. */
interface Segment {
  group: Group;
  jobs: JobListItem[];
  /** Index in the group of the first job shown here (> 0 when the group continues from the previous page). */
  start: number;
}

function toSegments(lines: Line[]): Segment[] {
  const out: Segment[] = [];
  for (const l of lines) {
    const last = out[out.length - 1];
    if (l.job && last && last.group === l.group) {
      last.jobs.push(l.job);
      continue;
    }
    out.push({ group: l.group, jobs: l.job ? [l.job] : [], start: l.job ? l.group.items.indexOf(l.job) : 0 });
  }
  return out;
}

export default function JobsScreen({ navigate }: { navigate: Navigate }) {
  const jobs = useIpc('jobs:list', {});
  const settings = useIpc('settings:get', {});
  const profiles = useIpc('profiles:list', {});
  // Analyze runs and background link fetches can fire this many times a second; reloading the whole list each time is
  // what made large lists freeze. Coalesce into at most one reload per window.
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useIpcEvent('jobs:updated', () => {
    if (reloadTimer.current) return;
    reloadTimer.current = setTimeout(() => {
      reloadTimer.current = null;
      void jobs.reload();
    }, 1500);
  });
  useEffect(
    () => () => {
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
    },
    [],
  );
  const [range, setRange] = useState<DateRange | null>(null);
  const [dateField, setDateField] = useState<JobDateField>('posted');
  const [inRangeOnly, setInRangeOnly] = useState(false);
  const [profileFilter, setProfileFilter] = useState<ProfileFilter>('all');
  const [search, setSearch] = useState('');
  const [groupBy, setGroupBy] = useState<GroupBy>('source');
  const [sortBy, setSortBy] = useState<SortBy>('posted');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [batchOnly, setBatchOnly] = useState(false);
  const [pasteJob, setPasteJob] = useState<JobListItem | null>(null);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(100);
  const listTop = useRef<HTMLDivElement>(null);
  const deferredSearch = useDeferredValue(search);
  const action = useAction();
  const confirm = useConfirm();

  useEffect(() => {
    if (settings.data && !range) setRange(settings.data.defaultDateRange);
  }, [settings.data, range]);

  const all = jobs.data ?? [];
  // The latest paste: every link in it, newly saved or already saved before.
  const latestBatch = useMemo(() => all.reduce<string | null>((m, j) => (j.lastAddedAt && (!m || j.lastAddedAt > m) ? j.lastAddedAt : m), null), [all]);
  const batchOf = (j: JobListItem): 'new' | 'again' | null =>
    latestBatch && j.lastAddedAt === latestBatch ? (j.firstSeenAt === j.lastAddedAt ? 'new' : 'again') : null;
  const batchIds = useMemo(() => all.filter((j) => latestBatch && j.lastAddedAt === latestBatch).map((j) => j.id), [all, latestBatch]);
  const filtered = useMemo(() => {
    const q = deferredSearch.trim().toLowerCase();
    const bounds = inRangeOnly && range ? resolveDateRange(range, new Date()) : null;
    const [mode, pid] = profileFilter.split(':');
    const forProfile = (j: JobListItem) => j.analyses.some((a) => a.profileId === Number(pid));
    const profileOk = (j: JobListItem) =>
      mode === 'in' ? forProfile(j) : mode === 'out' ? !forProfile(j) : mode === 'none' ? j.analyses.length === 0 : true;
    if (!q && !bounds && profileFilter === 'all' && !batchOnly) return all;
    return all.filter(
      (j) =>
        (!batchOnly || (latestBatch != null && j.lastAddedAt === latestBatch)) &&
        (!bounds || jobInDateRange(j, bounds, dateField)) &&
        profileOk(j) &&
        (!q || [j.url, j.title, j.companyName, j.sourceLabel, ...j.extraUrls].some((v) => v?.toLowerCase().includes(q))),
    );
  }, [all, deferredSearch, inRangeOnly, range, dateField, profileFilter, batchOnly, latestBatch]);
  const groups = useMemo(() => groupItems(sortItems(filtered, sortBy), groupBy).filter((g) => g.items.length > 0), [filtered, sortBy, groupBy]);

  // Paginate over the grouped order, so a group's rows stay together across pages.
  const lines = useMemo(() => groups.flatMap((g): Line[] => (collapsed.has(g.key) ? [{ group: g, job: null }] : g.items.map((job) => ({ group: g, job })))), [groups, collapsed]);
  const pageCount = Math.max(1, Math.ceil(lines.length / pageSize));
  const pageIndex = Math.min(page, pageCount - 1);
  const pageStart = pageIndex * pageSize;
  const segments = useMemo(() => toSegments(lines.slice(pageStart, pageStart + pageSize)), [lines, pageStart, pageSize]);
  useEffect(() => {
    setPage(0);
  }, [deferredSearch, inRangeOnly, range, dateField, profileFilter, batchOnly, sortBy, groupBy, pageSize]);
  const goToPage = (p: number) => {
    setPage(p);
    if (listTop.current && listTop.current.getBoundingClientRect().top < 0) listTop.current.scrollIntoView({ block: 'start' });
  };

  // Rows on this page, in display order — the order drag/shift selection follows.
  const visibleIds = useMemo(() => segments.flatMap((s) => s.jobs.map((j) => j.id)), [segments]);
  const filteredIds = useMemo(() => filtered.map((j) => j.id), [filtered]);
  const sel = useRowSelection(visibleIds);
  const selectedIds = useMemo(() => all.filter((j) => sel.selected.has(j.id)).map((j) => j.id), [all, sel.selected]);
  const selectedCount = selectedIds.length;

  const refetch = async (ids: number[]) => {
    if (!ids.length) return;
    const ok = await confirm({
      title: `Re-fetch ${ids.length} job${ids.length === 1 ? '' : 's'}?`,
      message:
        'Their pages are downloaded and read again on the next analysis run (a small extraction cost per job, shown in the estimate). Existing scores are kept. Jobs with a pasted description are skipped.',
      confirmLabel: 'Re-fetch',
    });
    if (!ok) return;
    void action.run(async () => {
      await invoke('jobs:refetch', { ids });
      await jobs.reload();
    });
  };

  const remove = async (ids: number[]) => {
    if (!ids.length) return;
    const ok = await confirm({
      title: `Delete ${ids.length} job${ids.length === 1 ? '' : 's'}?`,
      message: 'They are removed from the database.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    void action.run(async () => {
      await invoke('jobs:delete', { ids });
      sel.setMany(ids, false);
      await jobs.reload();
    });
  };
  // Stable callbacks for the memoized rows.
  const removeRef = useRef(remove);
  removeRef.current = remove;
  const deleteRow = useCallback((id: number) => void removeRef.current([id]), []);

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex items-baseline gap-3">
        <h1 className="text-xl font-semibold">Jobs</h1>
        <span className="text-sm text-slate-500">{all.length} saved link{all.length === 1 ? '' : 's'}</span>
      </div>

      <AddLinksCard
        onAdded={() => void jobs.reload()}
      />

      <AnalyzePanel
        navigate={navigate}
        range={range}
        onRangeChange={setRange}
        dateField={dateField}
        onDateFieldChange={setDateField}
        selectedJobIds={selectedIds}
        onPaste={setPasteJob}
        refreshKey={jobs.data}
      >
        <Card title="Saved jobs">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search URL, title, company, source…" className="w-72" />
            <label className="flex items-center gap-1.5 text-sm text-slate-600">
              Group by
              <Select value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
                {(Object.keys(GROUP_LABELS) as GroupBy[]).map((g) => (
                  <option key={g} value={g}>
                    {GROUP_LABELS[g]}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex items-center gap-1.5 text-sm text-slate-600">
              Sort
              <Select value={sortBy} onChange={(e) => setSortBy(e.target.value as SortBy)}>
                {(Object.keys(SORT_LABELS) as SortBy[]).map((s) => (
                  <option key={s} value={s}>
                    {SORT_LABELS[s]}
                  </option>
                ))}
              </Select>
            </label>
            {batchIds.length > 0 && (
              <>
                <label className="flex items-center gap-1.5 text-sm text-slate-600" title="Only the links from your latest paste (new and added again)">
                  <input type="checkbox" checked={batchOnly} onChange={(e) => setBatchOnly(e.target.checked)} />
                  Latest paste only ({batchIds.length})
                </label>
                <Button size="sm" onClick={() => sel.setMany(batchIds, true)} title="Select every link from your latest paste — then Analyze → Selected in list">
                  Select latest paste
                </Button>
              </>
            )}
            <label className="flex items-center gap-1.5 text-sm text-slate-600">
              Profile
              <Select value={profileFilter} onChange={(e) => setProfileFilter(e.target.value)}>
                <option value="all">Any</option>
                <option value="none">Not analyzed for any profile</option>
                {(profiles.data ?? []).map((p) => (
                  <optgroup key={p.id} label={p.name}>
                    <option value={`in:${p.id}`}>Analyzed for {p.name}</option>
                    <option value={`out:${p.id}`}>Not analyzed for {p.name}</option>
                  </optgroup>
                ))}
              </Select>
            </label>
            <label className="flex items-center gap-1.5 text-sm text-slate-600" title="Show only jobs inside the date range chosen under Analyze">
              <input type="checkbox" checked={inRangeOnly} onChange={(e) => setInRangeOnly(e.target.checked)} />
              Only in analysis range ({DATE_FIELD_LABELS[dateField].toLowerCase()})
            </label>
            {groupBy !== 'none' && (
              <>
                <Button size="sm" variant="ghost" onClick={() => setCollapsed(new Set())}>
                  Expand all
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setCollapsed(new Set(groups.map((g) => g.key)))}>
                  Collapse all
                </Button>
              </>
            )}
            <div className="ml-auto flex items-center gap-2">
              {filtered.length !== all.length && (
                <span className="text-xs text-slate-500">
                  {filtered.length} of {all.length} shown
                </span>
              )}
              <span className="text-sm font-medium text-slate-700">{selectedCount} selected</span>
              {pageCount > 1 && (
                <Button size="sm" variant="ghost" disabled={!visibleIds.length} onClick={() => sel.setMany(visibleIds, true)}>
                  Select page
                </Button>
              )}
              <Button size="sm" variant="ghost" disabled={!filteredIds.length} onClick={() => sel.setMany(filteredIds, true)} title="Every job matching the current filters, on all pages">
                Select all {pageCount > 1 ? filteredIds.length : 'shown'}
              </Button>
              <Button size="sm" variant="ghost" disabled={!selectedCount} onClick={sel.clear}>
                Select none
              </Button>
              <Button size="sm" variant="danger" disabled={action.busy || !selectedCount} onClick={() => void remove(selectedIds)}>
                Delete selected
              </Button>
              <Button size="sm" disabled={action.busy || !selectedCount} onClick={() => void refetch(selectedIds)} title="Download and read the selected jobs again on the next analysis">
                Re-fetch selected
              </Button>
            </div>
          </div>

          <p className="mb-2 text-xs text-slate-500">Tip: drag down the checkboxes to select a run of jobs · Shift-click for a range · Ctrl-click a row to toggle it.</p>
          <ErrorBox error={jobs.error ?? action.error} />
          {jobs.loading && !jobs.data && <p className="py-6 text-center text-sm text-slate-500">Loading…</p>}
          {jobs.data && all.length === 0 && <p className="py-10 text-center text-sm text-slate-500">No jobs yet — paste some links above.</p>}
          {jobs.data && all.length > 0 && filtered.length === 0 && (
            <p className="py-6 text-center text-sm text-slate-500">{search ? `No jobs match "${search}" with the current filters.` : 'No jobs match the current filters.'}</p>
          )}

          <div ref={listTop} className="flex scroll-mt-4 flex-col gap-3">
            {lines.length > 0 && (
              <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500">
                <span className="tabular-nums">
                  {filtered.length} job{filtered.length === 1 ? '' : 's'}
                  {groupBy !== 'none' && ` in ${groups.length} group${groups.length === 1 ? '' : 's'}`}
                </span>
                <label className="flex items-center gap-1.5">
                  Per page
                  <Select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>
                    {PAGE_SIZES.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </Select>
                </label>
                <div className="ml-auto">
                  <Pager page={pageIndex} pageCount={pageCount} onPage={goToPage} />
                </div>
              </div>
            )}
            {segments.map((s) => {
              const g = s.group;
              const isCollapsed = collapsed.has(g.key);
              const allSel = g.items.every((j) => sel.selected.has(j.id));
              const partial = !isCollapsed && s.jobs.length < g.items.length;
              return (
                <div key={g.key} className="overflow-hidden rounded-md border border-slate-200">
                  {groupBy !== 'none' && (
                    <div className="flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2">
                      <input type="checkbox" checked={allSel} onChange={() => sel.setMany(g.items.map((j) => j.id), !allSel)} title="Select all in group (on every page)" />
                      <button
                        type="button"
                        className="flex flex-1 items-center gap-2 text-left"
                        onClick={() =>
                          setCollapsed((c) => {
                            const n = new Set(c);
                            if (n.has(g.key)) n.delete(g.key);
                            else n.add(g.key);
                            return n;
                          })
                        }
                      >
                        <span className="w-3 text-xs text-slate-400">{isCollapsed ? '▸' : '▾'}</span>
                        <span className="font-semibold text-slate-700">{g.label}</span>
                        <Badge>{g.items.length}</Badge>
                        {partial && (
                          <span className="text-xs tabular-nums text-slate-500">
                            {s.start > 0 ? 'continued · ' : ''}
                            {s.start + 1}–{s.start + s.jobs.length} here
                          </span>
                        )}
                      </button>
                    </div>
                  )}
                  {s.jobs.length > 0 && (
                    <table className="w-full table-fixed text-sm">
                      <tbody>
                        {s.jobs.map((j) => (
                          <JobRow
                            key={j.id}
                            job={j}
                            selected={sel.selected.has(j.id)}
                            handleProps={sel.handleProps}
                            rowProps={sel.rowProps}
                            batch={batchOf(j)}
                            onDelete={deleteRow}
                            onPaste={setPasteJob}
                          />
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              );
            })}
            {pageCount > 1 && (
              <div className="flex justify-center">
                <Pager page={pageIndex} pageCount={pageCount} onPage={goToPage} />
              </div>
            )}
          </div>
        </Card>
      </AnalyzePanel>

      {pasteJob && (
        <PasteDialog
          job={pasteJob}
          onClose={() => setPasteJob(null)}
          onSaved={() => {
            setPasteJob(null);
            void jobs.reload();
          }}
        />
      )}
    </div>
  );
}
