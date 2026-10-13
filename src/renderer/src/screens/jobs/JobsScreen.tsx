import { useEffect, useMemo, useState } from 'react';
import { FETCH_STATUSES, FETCH_STATUS_LABELS, type AddLinksResult, type JobListItem, type JobProfileAnalysis } from '@shared/jobs';
import { jobInDateRange, resolveDateRange, type JobDateField } from '@shared/dates';
import type { DateRange } from '@shared/settings';
import { invoke, useIpc, useIpcEvent } from '../../api';
import { Badge, Button, Card, ErrorBox, Input, Select, Textarea, cx, useAction } from '../../components/ui';
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
        return cmpText(a.companyName, b.companyName) || cmpText(a.title, b.title) || a.url.localeCompare(b.url);
      case 'title':
        return cmpText(a.title, b.title) || a.url.localeCompare(b.url);
      case 'url':
        return a.url.localeCompare(b.url);
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
        <span className="text-xs text-slate-500">Tracking parameters are removed and duplicates are skipped automatically.</span>
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
            <span className="text-slate-600">{result.duplicates.length} duplicate{result.duplicates.length === 1 ? '' : 's'} skipped</span>
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

function ProfileBadge({ a }: { a: JobProfileAnalysis }) {
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

function JobRow({
  job,
  sel,
  isNew,
  onDelete,
  onPaste,
}: {
  job: JobListItem;
  sel: ReturnType<typeof useRowSelection>;
  isNew: boolean;
  onDelete: () => void;
  onPaste: () => void;
}) {
  const selected = sel.isSelected(job.id);
  return (
    <tr className={cx('group border-b border-slate-100 last:border-0 hover:bg-slate-50', selected && 'bg-indigo-50/60')} {...sel.rowProps(job.id)}>
      <td className="w-10 py-2 pl-3 align-top" {...sel.handleProps(job.id)}>
        <input type="checkbox" readOnly checked={selected} className="pointer-events-none mt-1" />
      </td>
      <td className="min-w-0 py-2 pr-3 align-top">
        <div className="flex items-center gap-2">
          <a href={job.url} target="_blank" rel="noreferrer" className="truncate font-medium text-indigo-700 hover:underline" title={job.url}>
            {job.title ?? displayUrl(job.url)}
          </a>
          {isNew && <Badge tone="green">new</Badge>}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-slate-500">
          {job.companyName && <span className="shrink-0 font-medium text-slate-600">{job.companyName}</span>}
          {job.location && <span className="max-w-64 shrink-0 truncate" title={job.location}>{job.location}</span>}
          {job.title && (
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
          <button type="button" onClick={onPaste} title={`${job.fetchError ?? ''}
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
        <button type="button" onClick={onDelete} className="invisible text-xs text-red-600 hover:underline group-hover:visible">
          Delete
        </button>
      </td>
    </tr>
  );
}

export default function JobsScreen({ navigate }: { navigate: Navigate }) {
  const jobs = useIpc('jobs:list', {});
  const settings = useIpc('settings:get', {});
  const profiles = useIpc('profiles:list', {});
  useIpcEvent('jobs:updated', () => void jobs.reload());
  const [range, setRange] = useState<DateRange | null>(null);
  const [dateField, setDateField] = useState<JobDateField>('posted');
  const [inRangeOnly, setInRangeOnly] = useState(false);
  const [profileFilter, setProfileFilter] = useState<ProfileFilter>('all');
  const [search, setSearch] = useState('');
  const [groupBy, setGroupBy] = useState<GroupBy>('source');
  const [sortBy, setSortBy] = useState<SortBy>('posted');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [newIds, setNewIds] = useState<Set<number>>(new Set());
  const [pasteJob, setPasteJob] = useState<JobListItem | null>(null);
  const action = useAction();
  const confirm = useConfirm();

  useEffect(() => {
    if (settings.data && !range) setRange(settings.data.defaultDateRange);
  }, [settings.data, range]);

  const all = jobs.data ?? [];
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const bounds = inRangeOnly && range ? resolveDateRange(range, new Date()) : null;
    const [mode, pid] = profileFilter.split(':');
    const forProfile = (j: JobListItem) => j.analyses.some((a) => a.profileId === Number(pid));
    const profileOk = (j: JobListItem) =>
      mode === 'in' ? forProfile(j) : mode === 'out' ? !forProfile(j) : mode === 'none' ? j.analyses.length === 0 : true;
    if (!q && !bounds && profileFilter === 'all') return all;
    return all.filter(
      (j) =>
        (!bounds || jobInDateRange(j, bounds, dateField)) &&
        profileOk(j) &&
        (!q || [j.url, j.title, j.companyName, j.sourceLabel, ...j.extraUrls].some((v) => v?.toLowerCase().includes(q))),
    );
  }, [all, search, inRangeOnly, range, dateField, profileFilter]);
  const groups = useMemo(() => groupItems(sortItems(filtered, sortBy), groupBy), [filtered, sortBy, groupBy]);

  // Rows currently on screen, in display order (collapsed groups excluded) — the order drag/shift selection follows.
  const visibleIds = useMemo(() => groups.filter((g) => !collapsed.has(g.key)).flatMap((g) => g.items.map((j) => j.id)), [groups, collapsed]);
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
      message: 'They are removed from the database. Collecting again may add them back if they are still listed.',
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

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex items-baseline gap-3">
        <h1 className="text-xl font-semibold">Jobs</h1>
        <span className="text-sm text-slate-500">{all.length} saved link{all.length === 1 ? '' : 's'}</span>
      </div>

      <AddLinksCard
        onAdded={(r) => {
          setNewIds(new Set(r.added.map((j) => j.id)));
          void jobs.reload();
        }}
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
              <Button size="sm" variant="ghost" disabled={!visibleIds.length} onClick={() => sel.setMany(visibleIds, true)}>
                Select all shown
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

          <div className="flex flex-col gap-3">
            {groups
              .filter((g) => g.items.length > 0)
              .map((g) => {
                const isCollapsed = collapsed.has(g.key);
                const ids = g.items.map((j) => j.id);
                const allSel = ids.every((id) => sel.selected.has(id));
                return (
                  <div key={g.key} className="overflow-hidden rounded-md border border-slate-200">
                    {groupBy !== 'none' && (
                      <div className="flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2">
                        <input type="checkbox" checked={allSel} onChange={() => sel.setMany(ids, !allSel)} title="Select all in group" />
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
                        </button>
                      </div>
                    )}
                    {!isCollapsed && (
                      <table className="w-full table-fixed text-sm">
                        <tbody>
                          {g.items.map((j) => (
                            <JobRow key={j.id} job={j} sel={sel} isNew={newIds.has(j.id)} onDelete={() => void remove([j.id])} onPaste={() => setPasteJob(j)} />
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                );
              })}
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
