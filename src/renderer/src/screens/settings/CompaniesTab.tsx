import { useState } from 'react';
import { ADAPTER_KEYS, ADAPTER_LABELS, type AdapterKeyShared, type CompanyRow, type DetectResult } from '@shared/collect';
import { invoke, useIpc } from '../../api';
import { Badge, Button, Card, ErrorBox, Field, Input, Select, Spinner, Textarea, Toggle, cx, useAction } from '../../components/ui';
import { useConfirm } from '../../components/confirm';
import { useRowSelection } from '../../hooks/useRowSelection';

export const ATS_TONES: Record<AdapterKeyShared, 'green' | 'blue' | 'indigo' | 'amber' | 'slate'> = {
  greenhouse: 'green',
  lever: 'blue',
  ashby: 'indigo',
  workday: 'amber',
  icims: 'blue',
  generic: 'slate',
};

export function HealthBadge({ h }: { h: CompanyRow['lastHealth'] }) {
  if (!h) return <span className="text-xs text-slate-400">never collected</span>;
  const tone = h.status === 'ok' ? 'green' : h.status === 'warning' ? 'amber' : 'red';
  return (
    <span className="flex items-center gap-1.5 text-xs" title={h.error ?? undefined}>
      <Badge tone={tone}>{h.status === 'ok' ? 'OK' : h.status === 'warning' ? 'warning' : 'failed'}</Badge>
      <span className="text-slate-500">{h.status === 'failed' ? h.error : `${h.jobsFound} listed · ${new Date(h.createdAt).toLocaleDateString()}`}</span>
    </span>
  );
}

function AddCompany({ onAdded }: { onAdded: (list: CompanyRow[]) => void }) {
  const [url, setUrl] = useState('');
  const [detected, setDetected] = useState<DetectResult | null>(null);
  const [name, setName] = useState('');
  const [ats, setAts] = useState<AdapterKeyShared>('generic');
  const [token, setToken] = useState('');
  const [careersUrl, setCareersUrl] = useState('');
  const action = useAction();

  const detect = () =>
    action.run(async () => {
      const d = await invoke('companies:detect', { url });
      setDetected(d);
      setName(d.suggestedName ?? '');
      setAts(d.atsType);
      setToken(d.boardToken ?? '');
      setCareersUrl(d.careersUrl);
    });

  const reset = () => {
    setUrl('');
    setDetected(null);
  };

  return (
    <Card title="Add a company">
      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (url.trim()) void detect();
        }}
      >
        <Field label="Careers page or ATS board URL">
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://stripe.com/jobs or https://jobs.lever.co/acme" className="w-[32rem]" />
        </Field>
        <Button type="submit" variant="primary" disabled={action.busy || !url.trim()}>
          {action.busy && !detected ? <Spinner className="border-white/40 border-t-white" /> : null}
          Detect
        </Button>
      </form>
      {detected && (
        <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-3">
          <p className={cx('mb-2 text-sm', detected.atsType === 'generic' ? 'text-amber-700' : 'text-emerald-700')}>
            {detected.atsType === 'generic' ? 'unknown → generic. ' : '✓ '}
            {detected.message}
          </p>
          <div className="grid grid-cols-[1.2fr_150px_1fr_2fr] gap-2">
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="ATS">
              <Select value={ats} onChange={(e) => setAts(e.target.value as AdapterKeyShared)}>
                {ADAPTER_KEYS.map((k) => (
                  <option key={k} value={k}>
                    {ADAPTER_LABELS[k]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Board token">
              <Input value={token} disabled={ats === 'generic'} onChange={(e) => setToken(e.target.value)} placeholder={ats === 'workday' ? 'tenant/site' : ''} />
            </Field>
            <Field label="URL used for collection">
              <Input value={careersUrl} onChange={(e) => setCareersUrl(e.target.value)} />
            </Field>
          </div>
          <div className="mt-2 flex gap-2">
            <Button
              variant="primary"
              disabled={action.busy || !name.trim() || (ats !== 'generic' && !token.trim())}
              onClick={() =>
                action.run(async () => {
                  onAdded(await invoke('companies:add', { name, careersUrl, atsType: ats, boardToken: ats === 'generic' ? null : token.trim() }));
                  reset();
                })
              }
            >
              Add company
            </Button>
            <Button onClick={reset}>Cancel</Button>
          </div>
        </div>
      )}
      <div className="mt-2">
        <ErrorBox error={action.error} />
      </div>
    </Card>
  );
}

function BulkAdd({ onDone }: { onDone: (list: CompanyRow[]) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [log, setLog] = useState<{ url: string; ok: boolean; msg: string }[]>([]);
  const action = useAction();

  const run = () =>
    action.run(async () => {
      const urls = text.split(/\s+/).map((s) => s.trim()).filter(Boolean);
      const out: typeof log = [];
      setLog([]);
      for (const url of urls) {
        try {
          const d = await invoke('companies:detect', { url });
          await invoke('companies:add', { name: d.suggestedName ?? url, careersUrl: d.careersUrl, atsType: d.atsType, boardToken: d.boardToken });
          out.push({ url, ok: true, msg: `${d.suggestedName ?? ''} — ${ADAPTER_LABELS[d.atsType]}${d.boardToken ? ` (${d.boardToken})` : ''}` });
        } catch (e) {
          out.push({ url, ok: false, msg: (e as Error).message });
        }
        setLog([...out]);
      }
      onDone(await invoke('companies:list', {}));
      setText('');
    });

  if (!open)
    return (
      <Button size="sm" onClick={() => setOpen(true)}>
        Add several at once…
      </Button>
    );
  return (
    <Card title="Add several companies" actions={<Button size="sm" onClick={() => setOpen(false)}>Close</Button>}>
      <Textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder="One careers URL per line" className="font-mono text-xs" />
      <Button className="mt-2" variant="primary" disabled={action.busy || !text.trim()} onClick={run}>
        {action.busy ? 'Detecting…' : 'Detect and add all'}
      </Button>
      {log.length > 0 && (
        <div className="mt-2 max-h-48 overflow-auto font-mono text-xs">
          {log.map((l, i) => (
            <div key={i} className={l.ok ? 'text-emerald-700' : 'text-red-600'}>
              {l.ok ? '✓' : '✗'} {l.url} — {l.msg}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function CompanyRowView({ c, onChange, sel }: { c: CompanyRow; onChange: (list: CompanyRow[]) => void; sel: ReturnType<typeof useRowSelection> }) {
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ name: c.name, careersUrl: c.careersUrl, atsType: c.atsType, boardToken: c.boardToken ?? '' });
  const [test, setTest] = useState<{ ok: boolean; jobsFound: number; sample: string[]; error: string | null; durationMs: number } | null>(null);
  const action = useAction();

  if (editing)
    return (
      <tr className="bg-indigo-50/40">
        <td className="p-2" colSpan={7}>
          <div className="grid grid-cols-[1.2fr_150px_1fr_2fr_auto] items-end gap-2">
            <Field label="Name">
              <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </Field>
            <Field label="ATS">
              <Select value={draft.atsType} onChange={(e) => setDraft({ ...draft, atsType: e.target.value as AdapterKeyShared })}>
                {ADAPTER_KEYS.map((k) => (
                  <option key={k} value={k}>
                    {ADAPTER_LABELS[k]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Board token">
              <Input value={draft.boardToken} disabled={draft.atsType === 'generic'} onChange={(e) => setDraft({ ...draft, boardToken: e.target.value })} />
            </Field>
            <Field label="Careers URL">
              <Input value={draft.careersUrl} onChange={(e) => setDraft({ ...draft, careersUrl: e.target.value })} />
            </Field>
            <div className="flex gap-1 pb-0.5">
              <Button
                size="sm"
                variant="primary"
                disabled={action.busy}
                onClick={() =>
                  action.run(async () => {
                    onChange(await invoke('companies:update', { id: c.id, ...draft, boardToken: draft.atsType === 'generic' ? null : draft.boardToken.trim() || null }));
                    setEditing(false);
                  })
                }
              >
                Save
              </Button>
              <Button size="sm" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </div>
          <ErrorBox error={action.error} />
        </td>
      </tr>
    );

  return (
    <>
      <tr className={cx('border-b border-slate-100 align-top hover:bg-slate-50', !c.enabled && 'opacity-60', sel.isSelected(c.id) && 'bg-indigo-50/60')} {...sel.rowProps(c.id)}>
        <td className="w-9 p-2 pt-3" {...sel.handleProps(c.id)}>
          <input type="checkbox" readOnly checked={sel.isSelected(c.id)} className="pointer-events-none" />
        </td>
        <td className="p-2">
          <Toggle checked={c.enabled} onChange={(v) => action.run(async () => onChange(await invoke('companies:update', { id: c.id, enabled: v })))} />
        </td>
        <td className="p-2">
          <div className="font-medium">{c.name}</div>
          <a href={c.careersUrl} target="_blank" rel="noreferrer" className="block max-w-xs truncate text-xs text-indigo-600 hover:underline">
            {c.careersUrl.replace(/^https:\/\//, '')}
          </a>
        </td>
        <td className="p-2">
          <Badge tone={ATS_TONES[c.atsType]}>{ADAPTER_LABELS[c.atsType]}</Badge>
          {c.boardToken && <div className="mt-0.5 font-mono text-xs text-slate-500">{c.boardToken}</div>}
        </td>
        <td className="p-2">
          <HealthBadge h={c.lastHealth} />
        </td>
        <td className="p-2 text-right tabular-nums text-slate-600">{c.jobCount}</td>
        <td className="whitespace-nowrap p-2 text-right">
          <Button size="sm" variant="ghost" disabled={action.busy} onClick={() => action.run(async () => setTest(await invoke('companies:test', { id: c.id })))}>
            {action.busy && !editing ? 'Testing…' : 'Test'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            Edit
          </Button>
          <Button
            size="sm"
            variant="dangerGhost"
            onClick={async () => {
              if (await confirm({ title: `Remove ${c.name}?`, message: 'It will no longer be collected. Jobs already collected from it stay in your job list.', confirmLabel: 'Remove', danger: true }))
                void action.run(async () => onChange(await invoke('companies:delete', { id: c.id })));
            }}
          >
            Remove
          </Button>
        </td>
      </tr>
      {(test || action.error) && (
        <tr className="border-b border-slate-100">
          <td />
          <td />
          <td colSpan={5} className="px-2 pb-2 text-xs">
            {action.error && <span className="text-red-600">{action.error}</span>}
            {test &&
              (test.ok ? (
                <span className="text-emerald-700">
                  ✓ {test.jobsFound} postings found in {(test.durationMs / 1000).toFixed(1)}s{test.sample.length ? ` — e.g. ${test.sample.slice(0, 3).join('; ')}` : ''}
                </span>
              ) : (
                <span className="text-red-600">✗ {test.error}</span>
              ))}
          </td>
        </tr>
      )}
    </>
  );
}

export default function CompaniesTab() {
  const companies = useIpc('companies:list', {});
  const [filter, setFilter] = useState('');
  const list = (companies.data ?? []).filter((c) => !filter || `${c.name} ${c.careersUrl} ${c.atsType}`.toLowerCase().includes(filter.toLowerCase()));
  const sel = useRowSelection(list.map((c) => c.id));
  const confirm = useConfirm();
  const action = useAction();
  const chosen = (companies.data ?? []).filter((c) => sel.selected.has(c.id));
  const removeSelected = async () => {
    if (!chosen.length) return;
    const ok = await confirm({
      title: `Remove ${chosen.length} compan${chosen.length === 1 ? 'y' : 'ies'}?`,
      message: `${chosen.slice(0, 6).map((c) => c.name).join(', ')}${chosen.length > 6 ? '…' : ''}. Jobs already collected stay in your job list.`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    void action.run(async () => {
      companies.set(await invoke('companies:deleteMany', { ids: chosen.map((c) => c.id) }));
      sel.clear();
    });
  };

  return (
    <div className="flex max-w-6xl flex-col gap-4">
      <AddCompany onAdded={companies.set} />
      <div>
        <BulkAdd onDone={companies.set} />
      </div>
      <Card
        title={`Companies (${companies.data?.length ?? 0})`}
        actions={
          <>
            {chosen.length > 0 && (
              <>
                <span className="text-sm font-medium text-slate-700">{chosen.length} selected</span>
                <Button size="sm" variant="ghost" onClick={sel.clear}>
                  Clear
                </Button>
                <Button size="sm" variant="danger" disabled={action.busy} onClick={removeSelected}>
                  Remove selected
                </Button>
              </>
            )}
            <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter…" className="w-56" />
          </>
        }
      >
        <ErrorBox error={companies.error ?? action.error} />
        {companies.data && !companies.data.length && <p className="text-sm text-slate-500">No companies yet. Add careers URLs above; the app detects Greenhouse, Lever, Ashby and Workday automatically.</p>}
        {list.length > 0 && (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="w-9 p-2">
                  <input
                    type="checkbox"
                    title="Select all shown"
                    checked={list.length > 0 && list.every((c) => sel.selected.has(c.id))}
                    onChange={(e) => (e.target.checked ? sel.setMany(list.map((c) => c.id), true) : sel.clear())}
                  />
                </th>
                <th className="w-12 p-2">On</th>
                <th className="p-2">Company</th>
                <th className="p-2">ATS</th>
                <th className="p-2">Last collection</th>
                <th className="p-2 text-right">Jobs</th>
                <th className="p-2" />
              </tr>
            </thead>
            <tbody>
              {list.map((c) => (
                <CompanyRowView key={c.id} c={c} onChange={companies.set} sel={sel} />
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
