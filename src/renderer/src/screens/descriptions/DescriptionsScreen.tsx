import { useEffect, useMemo, useRef, useState } from 'react';
import { MIN_PASTED_TEXT } from '@shared/analysis';
import type { JobListItem } from '@shared/jobs';
import { invoke, useIpc, useIpcEvent } from '../../api';
import { Badge, Button, Card, ErrorBox, Input, JobLink, Spinner, Textarea, cx, useAction } from '../../components/ui';
import { useConfirm } from '../../components/confirm';
import { useRowSelection } from '../../hooks/useRowSelection';
import type { Navigate } from '../../App';
import AnalyzePanel from '../jobs/AnalyzePanel';
import { ProfileBadge } from '../jobs/JobsScreen';

function AddDescriptionCard({ onSaved }: { onSaved: (job: JobListItem, duplicate: boolean) => Promise<void> }) {
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const reading = useAction();
  const saving = useAction();
  const chars = text.trim().length;

  const readFile = (file: File) =>
    reading.run(async () => {
      const data = new Uint8Array(await file.arrayBuffer());
      const r = await invoke('jobs:readDescriptionFile', { fileName: file.name, data });
      setText(r.text);
      setFileName(file.name);
      setNotice(null);
    });

  const save = () =>
    saving.run(async () => {
      const r = await invoke('jobs:addDescription', { text, url: url.trim() || null });
      setText('');
      setUrl('');
      setFileName(null);
      setNotice(r.duplicate ? 'Already saved — that job was updated and is selected below.' : 'Saved — it is selected below, ready to analyze.');
      await onSaved(r.job, r.duplicate);
    });

  return (
    <Card title="Add a job description">
      <p className="-mt-1 mb-3 text-xs text-slate-500">
        Paste the job description or attach it as a file (PDF, DOCX or TXT). It's analyzed as written — nothing is fetched, so this works for postings the app can't open. The
        title, company and location are read from the text.
      </p>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files[0];
          if (f) void readFile(f);
        }}
        className={cx('rounded-md', dragging && 'ring-2 ring-indigo-400')}
      >
        <Textarea
          rows={12}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setNotice(null);
          }}
          placeholder="Paste the full job description here, or drop a PDF / DOCX / TXT file…"
          className="text-sm"
        />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button onClick={() => fileInput.current?.click()} disabled={reading.busy}>
          {reading.busy ? 'Reading…' : 'Attach file…'}
        </Button>
        {reading.busy && <Spinner />}
        {fileName && !reading.busy && <Badge tone="blue">{fileName}</Badge>}
        <input
          ref={fileInput}
          type="file"
          accept=".pdf,.docx,.txt,.md"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void readFile(f);
          }}
        />
        <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Link to the posting (optional)" className="w-80" />
        <span className="text-xs tabular-nums text-slate-500">
          {chars} characters{chars > 0 && chars < MIN_PASTED_TEXT ? ` — at least ${MIN_PASTED_TEXT}` : ''}
        </span>
        <Button variant="primary" className="ml-auto" disabled={saving.busy || chars < MIN_PASTED_TEXT} onClick={() => void save()}>
          {saving.busy ? 'Saving…' : 'Save description'}
        </Button>
      </div>
      <div className="mt-2 flex flex-col gap-1">
        <ErrorBox error={reading.error ?? saving.error} />
        {notice && <p className="text-sm text-emerald-700">✓ {notice}</p>}
      </div>
    </Card>
  );
}

export default function DescriptionsScreen({ navigate }: { navigate: Navigate }) {
  const jobs = useIpc('jobs:listDescriptions', {});
  const settings = useIpc('settings:get', {});
  // Analysis runs report many updates; reload at most once per window.
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
  const action = useAction();
  const confirm = useConfirm();

  // Most recently added first, so a new description is at the top.
  const list = useMemo(() => [...(jobs.data ?? [])].sort((a, b) => (b.lastAddedAt ?? b.firstSeenAt).localeCompare(a.lastAddedAt ?? a.firstSeenAt) || b.id - a.id), [jobs.data]);
  const ids = useMemo(() => list.map((j) => j.id), [list]);
  const sel = useRowSelection(ids);
  const selectedIds = useMemo(() => ids.filter((id) => sel.selected.has(id)), [ids, sel.selected]);

  const onSaved = async (job: JobListItem) => {
    await jobs.reload();
    sel.setMany([job.id], true);
  };

  const remove = async (del: number[]) => {
    if (!del.length) return;
    const ok = await confirm({
      title: `Delete ${del.length} job${del.length === 1 ? '' : 's'}?`,
      message: 'They are removed from the database, with their analyses.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    void action.run(async () => {
      await invoke('jobs:delete', { ids: del });
      sel.setMany(del, false);
      await jobs.reload();
    });
  };

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex items-baseline gap-3">
        <h1 className="text-xl font-semibold">Analyze descriptions</h1>
        <span className="text-sm text-slate-500">Analyze jobs from their description text — with or without a link.</span>
      </div>

      <AddDescriptionCard onSaved={onSaved} />

      <AnalyzePanel
        navigate={navigate}
        range={settings.data?.defaultDateRange ?? null}
        onRangeChange={() => {}}
        dateField="added"
        onDateFieldChange={() => {}}
        selectedJobIds={selectedIds}
        refreshKey={jobs.data}
        selectionOnly="description"
      >
        <Card title="Saved descriptions">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="text-sm text-slate-600">
              {list.length} saved · <span className="font-medium text-slate-700">{selectedIds.length} selected</span>
            </span>
            <div className="ml-auto flex items-center gap-2">
              <Button size="sm" variant="ghost" disabled={!ids.length} onClick={() => sel.setMany(ids, true)}>
                Select all
              </Button>
              <Button size="sm" variant="ghost" disabled={!selectedIds.length} onClick={sel.clear}>
                Select none
              </Button>
              <Button size="sm" variant="danger" disabled={action.busy || !selectedIds.length} onClick={() => void remove(selectedIds)}>
                Delete selected
              </Button>
            </div>
          </div>
          <ErrorBox error={jobs.error ?? action.error} />
          {jobs.loading && !jobs.data && <p className="py-6 text-center text-sm text-slate-500">Loading…</p>}
          {jobs.data && list.length === 0 && <p className="py-8 text-center text-sm text-slate-500">No descriptions yet — paste or attach one above.</p>}
          {list.length > 0 && (
            <div className="overflow-hidden rounded-md border border-slate-200">
              <table className="w-full table-fixed text-sm">
                <tbody>
                  {list.map((j) => {
                    const selected = sel.selected.has(j.id);
                    return (
                      <tr key={j.id} className={cx('group border-b border-slate-100 last:border-0 hover:bg-slate-50', selected && 'bg-indigo-50/60')} {...sel.rowProps(j.id)}>
                        <td className="w-10 py-2 pl-3 align-top" {...sel.handleProps(j.id)}>
                          <input type="checkbox" readOnly checked={selected} className="pointer-events-none mt-1" />
                        </td>
                        <td className="min-w-0 py-2 pr-3 align-top">
                          <JobLink href={j.url} className="block truncate font-medium text-indigo-700 hover:underline" title={j.url ?? undefined}>
                            {j.title ?? 'Untitled description'}
                          </JobLink>
                          <div className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-slate-500">
                            {j.companyName && <span className="shrink-0 font-medium text-slate-600">{j.companyName}</span>}
                            {j.location && (
                              <span className="truncate" title={j.location}>
                                {j.location}
                              </span>
                            )}
                            <span className="shrink-0 text-slate-400">{j.url ? `${j.sourceLabel} link` : 'No link'}</span>
                          </div>
                          {j.analyses.length > 0 && (
                            <div className="mt-1 flex flex-wrap gap-1">
                              {j.analyses.map((a) => (
                                <ProfileBadge key={a.profileId} a={a} />
                              ))}
                            </div>
                          )}
                        </td>
                        <td className="w-24 py-2 pr-3 align-top">{j.isClosed && <Badge tone="red">Closed</Badge>}</td>
                        <td className="w-32 py-2 pr-3 align-top text-xs tabular-nums text-slate-500">{new Date(j.lastAddedAt ?? j.firstSeenAt).toLocaleDateString()}</td>
                        <td className="w-16 py-2 pr-3 text-right align-top">
                          <button type="button" onClick={() => void remove([j.id])} className="invisible text-xs text-red-600 hover:underline group-hover:visible">
                            Delete
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </AnalyzePanel>
    </div>
  );
}
