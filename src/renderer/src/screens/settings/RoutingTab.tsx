import { useState } from 'react';
import { TASK_META } from '@shared/tasks';
import { resolveThinking } from '@shared/effort';
import { ALWAYS_ON_STYLES, PROVIDER_LABELS, clampEffort, type BuiltinProvider, type EffortLevel, type ModelRow, type TaskRoute, type TaskTestResult } from '@shared/types';
import { invoke, useIpc } from '../../api';
import { Badge, Button, Card, ErrorBox, Select, Toggle, useAction } from '../../components/ui';

function ModelSelect({ models, value, onChange, allowNone }: { models: ModelRow[]; value: number | null; onChange: (v: number | null) => void; allowNone?: string }) {
  return (
    <Select value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)} className="w-full">
      {allowNone !== undefined && <option value="">{allowNone}</option>}
      {value == null && allowNone === undefined && <option value="">Select a model…</option>}
      {models.map((m) => (
        <option key={m.id} value={m.id}>
          {m.display_name}
        </option>
      ))}
    </Select>
  );
}

function TestResult({ r }: { r: TaskTestResult }) {
  return (
    <div className={`mt-2 rounded-md border p-2 text-xs ${r.ok ? 'border-emerald-200 bg-emerald-50' : 'border-red-200 bg-red-50'}`}>
      {r.ok ? (
        <>
          <div className="mb-1 text-emerald-800">
            ✓ {r.model}
            {r.usedFallback && ' (fallback)'} · {(r.durationMs / 1000).toFixed(1)}s · {r.usage?.inputTokens} in / {r.usage?.cachedTokens} cached / {r.usage?.outputTokens} out · $
            {r.usage?.costUsd.toFixed(5)}
          </div>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-slate-700">{JSON.stringify(r.output, null, 2)}</pre>
        </>
      ) : (
        <div className="text-red-700">✗ {r.error}</div>
      )}
    </div>
  );
}

const providerName = (p: string) => PROVIDER_LABELS[p as BuiltinProvider] ?? p.replace(/^custom:/, '');

function RouteRow({ route, models, onChange }: { route: TaskRoute; models: ModelRow[]; onChange: (list: TaskRoute[]) => void }) {
  const meta = TASK_META[route.task];
  const action = useAction();
  const [test, setTest] = useState<TaskTestResult | null>(null);
  const model = models.find((m) => m.id === route.model_id);
  const fallback = models.find((m) => m.id === route.fallback_model_id);
  const canThink = !!model?.supports_thinking;
  const alwaysOn = !!model && ALWAYS_ON_STYLES.includes(model.thinking_style);
  const effective = model ? resolveThinking(model, route.thinking_enabled, route.effort) : null;
  const fallbackEffective = fallback ? resolveThinking(fallback, route.thinking_enabled, route.effort) : null;

  const update = (patch: Partial<TaskRoute>) => action.run(async () => onChange(await invoke('routes:update', { ...route, ...patch })));
  const changeModel = (id: number | null) => {
    const next = models.find((m) => m.id === id);
    // Keep the chosen effort if the new model supports it, otherwise snap to its nearest level.
    update({ model_id: id, effort: next ? clampEffort(route.effort, next.effort_levels) : route.effort });
  };

  return (
    <div className="border-b border-slate-100 py-4 last:border-0">
      <div className="grid grid-cols-[minmax(170px,1.3fr)_minmax(170px,1fr)_96px_minmax(140px,0.8fr)_minmax(170px,1fr)_auto] items-start gap-4">
        <div className="min-w-0">
          <div className="font-medium">{meta.label}</div>
          <div className="font-mono text-xs text-slate-400">{route.task}</div>
          <div className="mt-1 text-xs text-slate-500">{meta.description}</div>
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-xs font-medium text-slate-600">Model</span>
          <ModelSelect models={models} value={route.model_id} onChange={changeModel} />
          {meta.personalData ? (
            <span className="text-xs text-amber-700">⚠ Sends resume / personal data to {model ? providerName(model.provider) : 'this provider'}</span>
          ) : (
            <span className="text-xs text-slate-400">Public job text only</span>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-slate-600">Thinking</span>
          {canThink ? (
            alwaysOn ? (
              <span className="flex items-center gap-2 py-1 text-xs text-slate-500" title="This model always thinks; use effort to control how much.">
                <Toggle checked onChange={() => {}} disabled />
                Always on
              </span>
            ) : (
              <div className="py-1">
                <Toggle checked={route.thinking_enabled} onChange={(v) => update({ thinking_enabled: v })} />
              </div>
            )
          ) : (
            <span className="py-1.5 text-xs text-slate-400">{model ? 'Not supported' : '—'}</span>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-xs font-medium text-slate-600">Effort</span>
          <Select
            value={route.effort ?? ''}
            disabled={!model || model.effort_levels.length === 0}
            onChange={(e) => update({ effort: (e.target.value || null) as EffortLevel | null })}
          >
            <option value="">{model?.default_effort ? `Model default (${model.default_effort})` : 'Model default'}</option>
            {(model?.effort_levels ?? []).map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </Select>
          {model && model.effort_levels.length === 0 && <span className="text-xs text-slate-400">No effort control</span>}
          {effective?.note && <span className="text-xs text-slate-500">{effective.note}</span>}
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-xs font-medium text-slate-600">Fallback model</span>
          <ModelSelect models={models} value={route.fallback_model_id} onChange={(v) => update({ fallback_model_id: v })} allowNone="No fallback" />
          {fallbackEffective?.note && fallback && <span className="max-w-52 text-xs text-slate-500">Fallback: {fallbackEffective.note}</span>}
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-slate-600">&nbsp;</span>
          <Button
            size="md"
            disabled={action.busy}
            title="Runs the active prompt on a small synthetic sample (costs a fraction of a cent)"
            onClick={() => action.run(async () => setTest(await invoke('routes:test', { task: route.task })))}
          >
            {action.busy ? 'Running…' : 'Test route'}
          </Button>
        </div>
      </div>
      <ErrorBox error={action.error} />
      {test && <TestResult r={test} />}
    </div>
  );
}

export default function RoutingTab() {
  const routes = useIpc('routes:list', {});
  const models = useIpc('models:list', {});
  return (
    <Card title="Task routing">
      <p className="mb-2 text-sm text-slate-500">
        Choose which model runs each task. The fallback is used when the primary model errors after retries. Tasks marked <Badge tone="amber">⚠</Badge> include resume data — choose
        consciously which provider receives it.
      </p>
      <ErrorBox error={routes.error ?? models.error} />
      {routes.data && models.data && routes.data.map((r) => <RouteRow key={r.task} route={r} models={models.data!} onChange={routes.set} />)}
    </Card>
  );
}
