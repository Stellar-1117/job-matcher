import { useEffect, useState } from 'react';
import type { ExportOptions } from '@shared/results';
import { invoke } from '../../api';
import { Button, ErrorBox, cx, useAction } from '../../components/ui';

/** Export options (§13): .txt (one URL per line by default) or .csv, to a file or the clipboard. */
export default function ExportDialog({
  profileId,
  profileName,
  jobIds,
  alreadyExported,
  onClose,
  onDone,
}: {
  profileId: number;
  profileName: string;
  /** Selected jobs, in table order. */
  jobIds: number[];
  /** How many of them were exported before for this profile. */
  alreadyExported: number;
  onClose: () => void;
  onDone: (exportedIds: number[], message: string) => void;
}) {
  const [opts, setOpts] = useState<ExportOptions>({
    format: 'txt',
    include: { title: false, company: false, score: false },
    destination: 'file',
    skipExported: alreadyExported > 0,
  });
  const action = useAction();
  const count = jobIds.length - (opts.skipExported ? alreadyExported : 0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const run = () =>
    action.run(async () => {
      const r = await invoke('results:export', { profileId, jobIds, options: opts });
      if (r.cancelled) return;
      const what = `${r.exported} job${r.exported === 1 ? '' : 's'}`;
      const msg = opts.destination === 'clipboard' ? `Copied ${what} to the clipboard.` : `Exported ${what} to ${r.path}.`;
      onDone(r.exported ? jobIds : [], `${msg}${r.skipped ? ` ${r.skipped} already-exported skipped.` : ''} Marked as exported for ${profileName}.`);
    });

  const radio = (active: boolean) => cx('flex-1 rounded-md border px-3 py-2 text-left text-sm', active ? 'border-indigo-500 bg-indigo-50 ring-1 ring-indigo-500' : 'border-slate-300 hover:bg-slate-50');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" className="w-[32rem] max-w-[92vw] rounded-lg bg-white p-5 shadow-xl" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="text-base font-semibold text-slate-900">
          Export {jobIds.length} job{jobIds.length === 1 ? '' : 's'} · {profileName}
        </h2>

        <div className="mt-4 text-xs font-semibold uppercase tracking-wide text-slate-500">Format</div>
        <div className="mt-1 flex gap-2">
          <button type="button" className={radio(opts.format === 'txt')} onClick={() => setOpts({ ...opts, format: 'txt' })}>
            <div className="font-medium">.txt</div>
            <div className="text-xs text-slate-500">One URL per line</div>
          </button>
          <button type="button" className={radio(opts.format === 'csv')} onClick={() => setOpts({ ...opts, format: 'csv' })}>
            <div className="font-medium">.csv</div>
            <div className="text-xs text-slate-500">URL, title, company, location, score, verdict, summary</div>
          </button>
        </div>
        {opts.format === 'txt' && (
          <div className="mt-2 flex items-center gap-4 text-sm">
            <span className="text-xs text-slate-500">Also include:</span>
            {(['title', 'company', 'score'] as const).map((k) => (
              <label key={k} className="flex items-center gap-1.5">
                <input type="checkbox" checked={opts.include[k]} onChange={(e) => setOpts({ ...opts, include: { ...opts.include, [k]: e.target.checked } })} />
                {k[0].toUpperCase() + k.slice(1)}
              </label>
            ))}
          </div>
        )}

        <div className="mt-4 text-xs font-semibold uppercase tracking-wide text-slate-500">Destination</div>
        <div className="mt-1 flex gap-2">
          <button type="button" className={radio(opts.destination === 'file')} onClick={() => setOpts({ ...opts, destination: 'file' })}>
            <div className="font-medium">Save to a file…</div>
          </button>
          <button type="button" className={radio(opts.destination === 'clipboard')} onClick={() => setOpts({ ...opts, destination: 'clipboard' })}>
            <div className="font-medium">Copy to clipboard</div>
          </button>
        </div>

        {alreadyExported > 0 && (
          <label className="mt-4 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={opts.skipExported} onChange={(e) => setOpts({ ...opts, skipExported: e.target.checked })} />
            Skip the {alreadyExported} job{alreadyExported === 1 ? '' : 's'} already exported for this profile
          </label>
        )}
        <p className="mt-3 text-xs text-slate-500">Exported jobs are marked “Exported” for this profile only.</p>
        <div className="mt-2">
          <ErrorBox error={action.error} />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={action.busy || count < 1} onClick={() => void run()}>
            {opts.destination === 'clipboard' ? 'Copy' : 'Export'} {count} job{count === 1 ? '' : 's'}
          </Button>
        </div>
      </div>
    </div>
  );
}
