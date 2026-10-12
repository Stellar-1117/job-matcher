import { useEffect, useRef, useState } from 'react';
import type { JobListItem } from '@shared/jobs';
import { MIN_PASTED_TEXT } from '@shared/analysis';
import { invoke } from '../api';
import { Button, ErrorBox, Textarea, useAction } from './ui';

/**
 * "Needs manual paste" dialog (§3.3 step 4): the link, a button to open it in the system browser,
 * and a box to paste the job description, which is then analyzed like fetched text.
 */
export default function PasteDialog({ job, onClose, onSaved }: { job: JobListItem; onClose: () => void; onSaved: (job: JobListItem) => void }) {
  const [text, setText] = useState('');
  const action = useAction();
  const box = useRef<HTMLTextAreaElement>(null);
  const chars = text.trim().length;

  useEffect(() => {
    box.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = () =>
    action.run(async () => {
      onSaved(await invoke('jobs:pasteText', { id: job.id, text }));
    });
  const retry = () =>
    action.run(async () => {
      onSaved(await invoke('jobs:retryFetch', { id: job.id }));
    });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" className="flex max-h-[90vh] w-[44rem] max-w-[92vw] flex-col rounded-lg bg-white p-5 shadow-xl" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="text-base font-semibold text-slate-900">Paste the job description</h2>
        <p className="mt-1 text-sm text-slate-600">
          The app couldn't read this page{job.fetchError ? ` (${job.fetchError})` : ''}. Open it in your browser, copy the job description and paste it below.
        </p>
        <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
          <div className="font-medium text-slate-800">{job.title ?? 'Untitled job'}{job.companyName ? ` · ${job.companyName}` : ''}</div>
          <div className="mt-0.5 flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-500" title={job.url}>
              {job.url}
            </span>
            <a href={job.url} target="_blank" rel="noreferrer" className="shrink-0 rounded-md border border-indigo-300 bg-white px-2 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-50">
              Open in browser ↗
            </a>
          </div>
        </div>
        <Textarea
          ref={box}
          rows={14}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste the full job description here (title, responsibilities, requirements, location, salary…)"
          className="mt-3 min-h-40 flex-1 text-xs"
        />
        <div className="mt-1 text-xs text-slate-500">
          {chars} characters{chars > 0 && chars < MIN_PASTED_TEXT ? ` — paste at least ${MIN_PASTED_TEXT}` : ''}
        </div>
        <div className="mt-2">
          <ErrorBox error={action.error} />
        </div>
        <div className="mt-4 flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={retry} disabled={action.busy} title="Forget the failure; the next analysis tries to fetch the page again">
            Try fetching again
          </Button>
          <div className="ml-auto flex gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={action.busy || chars < MIN_PASTED_TEXT} onClick={save}>
              Save description
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
