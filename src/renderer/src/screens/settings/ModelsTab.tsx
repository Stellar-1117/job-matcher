import { useState } from 'react';
import { EFFORT_LEVELS, THINKING_STYLES, THINKING_STYLE_LABELS, type EffortLevel, type ModelInput, type ModelRow } from '@shared/types';
import { invoke, useIpc } from '../../api';
import { Badge, Button, Card, ErrorBox, Input, NumberInput, Select, Textarea, useAction } from '../../components/ui';
import { useConfirm } from '../../components/confirm';

const EMPTY: ModelInput = {
  display_name: '',
  provider: 'anthropic',
  model_id: '',
  supports_thinking: false,
  thinking_style: 'none',
  supports_json_schema: false,
  effort_levels: [],
  default_effort: null,
  server_fallback: false,
  price_in: 0,
  price_out: 0,
  price_cache_read: 0,
  notes: '',
};

function ModelEditor({
  initial,
  providers,
  onSave,
  onCancel,
  busy,
}: {
  initial: ModelInput;
  providers: { key: string; label: string }[];
  onSave: (m: ModelInput) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const [m, setM] = useState<ModelInput>(initial);
  const set = <K extends keyof ModelInput>(k: K, v: ModelInput[K]) => setM((prev) => ({ ...prev, [k]: v }));
  return (
    <tr className="bg-indigo-50/40 align-top">
      <td className="p-2">
        <Input value={m.display_name} onChange={(e) => set('display_name', e.target.value)} placeholder="Display name" className="w-full" />
      </td>
      <td className="p-2">
        <Select value={m.provider} onChange={(e) => set('provider', e.target.value)} className="w-full">
          {providers.map((p) => (
            <option key={p.key} value={p.key}>
              {p.label}
            </option>
          ))}
        </Select>
      </td>
      <td className="p-2">
        <Input value={m.model_id} onChange={(e) => set('model_id', e.target.value)} placeholder="API model string" className="w-full font-mono text-xs" />
      </td>
      <td className="p-2">
        <label className="flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={m.supports_thinking}
            onChange={(e) => {
              set('supports_thinking', e.target.checked);
              if (!e.target.checked) set('thinking_style', 'none');
            }}
          />
          Supports thinking
        </label>
        {m.supports_thinking && (
          <Select value={m.thinking_style} onChange={(e) => set('thinking_style', e.target.value as ModelInput['thinking_style'])} className="mt-1 w-full text-xs">
            {THINKING_STYLES.filter((s) => s !== 'none').map((s) => (
              <option key={s} value={s}>
                {THINKING_STYLE_LABELS[s]}
              </option>
            ))}
          </Select>
        )}
        <label className="mt-1 flex items-center gap-1.5 text-xs">
          <input type="checkbox" checked={m.supports_json_schema} onChange={(e) => set('supports_json_schema', e.target.checked)} />
          Native JSON schema
        </label>
        {m.provider === 'anthropic' && (
          <label className="mt-1 flex items-center gap-1.5 text-xs" title='Anthropic server-side refusal fallback (fallbacks: "default")'>
            <input type="checkbox" checked={m.server_fallback} onChange={(e) => set('server_fallback', e.target.checked)} />
            Server refusal fallback
          </label>
        )}
        <div className="mt-2 text-xs font-medium text-slate-600">Effort levels</div>
        <div className="flex flex-wrap gap-x-2">
          {EFFORT_LEVELS.map((l) => (
            <label key={l} className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={m.effort_levels.includes(l)}
                onChange={(e) => {
                  const next = e.target.checked ? [...m.effort_levels, l] : m.effort_levels.filter((x) => x !== l);
                  set('effort_levels', EFFORT_LEVELS.filter((x) => next.includes(x)));
                  if (!e.target.checked && m.default_effort === l) set('default_effort', null);
                }}
              />
              {l}
            </label>
          ))}
        </div>
        {m.effort_levels.length > 0 && (
          <Select value={m.default_effort ?? ''} onChange={(e) => set('default_effort', (e.target.value || null) as EffortLevel | null)} className="mt-1 w-full text-xs">
            <option value="">Default: unknown</option>
            {m.effort_levels.map((l) => (
              <option key={l} value={l}>
                Default: {l}
              </option>
            ))}
          </Select>
        )}
      </td>
      <td className="p-2">
        <NumberInput value={m.price_in} onCommit={(v) => set('price_in', v)} step={0.01} min={0} className="w-20" />
      </td>
      <td className="p-2">
        <NumberInput value={m.price_out} onCommit={(v) => set('price_out', v)} step={0.01} min={0} className="w-20" />
      </td>
      <td className="p-2">
        <NumberInput value={m.price_cache_read} onCommit={(v) => set('price_cache_read', v)} step={0.001} min={0} className="w-20" />
      </td>
      <td className="p-2">
        <Textarea value={m.notes} onChange={(e) => set('notes', e.target.value)} rows={2} className="text-xs" />
        <div className="mt-2 flex gap-2">
          <Button variant="primary" size="sm" disabled={busy || !m.display_name || !m.model_id} onClick={() => onSave(m)}>
            Save
          </Button>
          <Button size="sm" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </td>
    </tr>
  );
}

export default function ModelsTab() {
  const models = useIpc('models:list', {});
  const keys = useIpc('keys:list', {});
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const action = useAction();
  const confirm = useConfirm();

  const providers = (keys.data ?? []).map((k) => ({ key: k.provider, label: k.displayName }));
  const providerLabel = (p: string) => providers.find((x) => x.key === p)?.label ?? p;

  const save = (m: ModelInput) =>
    action.run(async () => {
      models.set(await invoke('models:upsert', m));
      setEditing(null);
    });

  const remove = async (m: ModelRow) => {
    if (!(await confirm({ title: `Delete model "${m.display_name}"?`, confirmLabel: 'Delete', danger: true }))) return;
    void action.run(async () => models.set(await invoke('models:delete', { id: m.id })));
  };

  return (
    <Card
      title="Model registry"
      actions={
        <Button variant="primary" size="sm" onClick={() => setEditing('new')} disabled={editing !== null}>
          Add model
        </Button>
      }
    >
      <p className="mb-3 text-sm text-slate-500">
        Prices are USD per million tokens and drive every cost estimate and usage entry. Model IDs and prices were checked against provider docs on 2026-09-29 — keep them up to date here.
      </p>
      <ErrorBox error={models.error ?? action.error} />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="p-2">Name</th>
              <th className="p-2">Provider</th>
              <th className="p-2">Model ID</th>
              <th className="p-2">Capabilities</th>
              <th className="p-2">In $/M</th>
              <th className="p-2">Out $/M</th>
              <th className="p-2">Cache read $/M</th>
              <th className="p-2">Notes</th>
            </tr>
          </thead>
          <tbody>
            {editing === 'new' && <ModelEditor initial={EMPTY} providers={providers} onSave={save} onCancel={() => setEditing(null)} busy={action.busy} />}
            {models.data?.map((m) =>
              editing === m.id ? (
                <ModelEditor key={m.id} initial={m} providers={providers} onSave={save} onCancel={() => setEditing(null)} busy={action.busy} />
              ) : (
                <tr key={m.id} className="border-b border-slate-100 align-top hover:bg-slate-50">
                  <td className="p-2 font-medium">{m.display_name}</td>
                  <td className="p-2">{providerLabel(m.provider)}</td>
                  <td className="whitespace-nowrap p-2 font-mono text-xs">{m.model_id}</td>
                  <td className="p-2">
                    <div className="flex flex-wrap gap-1">
                      {m.supports_thinking ? <Badge tone="indigo">{THINKING_STYLE_LABELS[m.thinking_style]}</Badge> : <Badge>No thinking</Badge>}
                      {m.supports_json_schema && <Badge tone="blue">JSON schema</Badge>}
                      {m.server_fallback && <Badge tone="green">Refusal fallback</Badge>}
                    </div>
                    <div className="mt-1 text-xs text-slate-500">
                      {m.effort_levels.length ? (
                        <>
                          Effort: {m.effort_levels.join(' · ')}
                          {m.default_effort && <span className="text-slate-400"> (default {m.default_effort})</span>}
                        </>
                      ) : (
                        'No effort control'
                      )}
                    </div>
                  </td>
                  <td className="p-2 tabular-nums">{m.price_in}</td>
                  <td className="p-2 tabular-nums">{m.price_out}</td>
                  <td className="p-2 tabular-nums">{m.price_cache_read}</td>
                  <td className="p-2">
                    <div className="max-w-sm text-xs text-slate-600">{m.notes}</div>
                    <div className="mt-1 flex gap-2">
                      <Button size="sm" variant="ghost" onClick={() => setEditing(m.id)} disabled={editing !== null}>
                        Edit
                      </Button>
                      <Button size="sm" variant="dangerGhost" onClick={() => void remove(m)} disabled={editing !== null}>
                        Delete
                      </Button>
                    </div>
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
