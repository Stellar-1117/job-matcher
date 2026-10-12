import { useEffect, useState } from 'react';
import type { AppSettings, DatePreset } from '@shared/settings';
import { SUB_SCORE_KEYS, SUB_SCORE_LABELS } from '@shared/scoring';
import { DEFAULT_TAXONOMY, TAXONOMY_LABELS, type TaxonomyField } from '@shared/taxonomy';
import { invoke, useIpc } from '../../api';
import { Button, Card, ErrorBox, Field, Input, NumberInput, Select, Textarea, Toggle, useAction } from '../../components/ui';
import { useConfirm } from '../../components/confirm';

function TaxonomyEditor({ settings, save }: { settings: AppSettings; save: (p: Partial<AppSettings>) => void }) {
  const fields = Object.keys(settings.taxonomy) as TaxonomyField[];
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const confirm = useConfirm();
  useEffect(() => {
    setDrafts(Object.fromEntries(fields.map((f) => [f, settings.taxonomy[f].join('\n')])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.taxonomy]);

  const dirty = fields.some((f) => drafts[f] !== settings.taxonomy[f].join('\n'));
  const parse = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);

  return (
    <Card
      title="Taxonomy (allowed values for job extraction)"
      actions={
        <>
          <Button size="sm" onClick={async () => (await confirm({ title: 'Reset all taxonomy lists to defaults?', confirmLabel: 'Reset' })) && save({ taxonomy: DEFAULT_TAXONOMY })}>
            Reset to defaults
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={!dirty}
            onClick={() => save({ taxonomy: Object.fromEntries(fields.map((f) => [f, parse(drafts[f] ?? '')])) as AppSettings['taxonomy'] })}
          >
            Save taxonomy
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-slate-500">One value per line. Injected into the extraction prompt as {'{{taxonomy}}'}; values outside these lists are stored as Unknown / Other.</p>
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        {fields.map((f) => (
          <Field key={f} label={TAXONOMY_LABELS[f]}>
            <Textarea rows={8} value={drafts[f] ?? ''} onChange={(e) => setDrafts((d) => ({ ...d, [f]: e.target.value }))} className="text-xs" />
          </Field>
        ))}
      </div>
    </Card>
  );
}

export default function GeneralTab() {
  const settings = useIpc('settings:get', {});
  const action = useAction();
  const s = settings.data;
  const save = (patch: Partial<AppSettings>) => action.run(async () => settings.set(await invoke('settings:update', patch)));

  if (!s) return <ErrorBox error={settings.error} />;
  const weightSum = SUB_SCORE_KEYS.reduce((acc, k) => acc + s.weights[k], 0);

  return (
    <div className="flex max-w-6xl flex-col gap-4">
      <ErrorBox error={action.error} />
      <div className="grid grid-cols-2 gap-4">
        <Card title="Score weights">
          <div className="grid grid-cols-5 gap-3">
            {SUB_SCORE_KEYS.map((k) => (
              <Field key={k} label={SUB_SCORE_LABELS[k]}>
                <NumberInput value={s.weights[k]} min={0} onCommit={(v) => save({ weights: { ...s.weights, [k]: v } })} className="w-full" />
              </Field>
            ))}
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Sum: {weightSum}. Totals are computed in code as Σ(score × weight) / Σ(weight) from the stored sub-scores, so the Results screen re-scores and re-sorts
            instantly — no LLM calls.
          </p>
          {weightSum <= 0 && <p className="mt-1 text-xs text-red-600">All weights are 0, so every total is 0. Give at least one category a weight.</p>}
        </Card>

        <Card title="Verdict thresholds">
          <div className="grid grid-cols-3 gap-3">
            <Field label="Strong ≥">
              <NumberInput value={s.thresholds.strong} onCommit={(v) => save({ thresholds: { ...s.thresholds, strong: v } })} className="w-full" />
            </Field>
            <Field label="Good ≥">
              <NumberInput value={s.thresholds.good} onCommit={(v) => save({ thresholds: { ...s.thresholds, good: v } })} className="w-full" />
            </Field>
            <Field label="Stretch ≥">
              <NumberInput value={s.thresholds.stretch} onCommit={(v) => save({ thresholds: { ...s.thresholds, stretch: v } })} className="w-full" />
            </Field>
          </div>
          <p className="mt-2 text-xs text-slate-500">Below Stretch = Skip. Verdicts update instantly on the Results screen.</p>
          {!(s.thresholds.strong >= s.thresholds.good && s.thresholds.good >= s.thresholds.stretch) && (
            <p className="mt-1 text-xs text-red-600">Thresholds should go Strong ≥ Good ≥ Stretch; otherwise some verdicts can never appear.</p>
          )}
        </Card>

        <Card title="Analysis">
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-4">
              <Toggle checked={s.preScore.enabled} onChange={(v) => save({ preScore: { ...s.preScore, enabled: v } })} label="Quick pre-score before matching" />
              <Field label="Skip below">
                <NumberInput value={s.preScore.threshold} min={0} max={100} onCommit={(v) => save({ preScore: { ...s.preScore, threshold: v } })} className="w-20" />
              </Field>
            </div>
            <Toggle checked={s.feedbackEnabled} onChange={(v) => save({ feedbackEnabled: v })} label="Show 👍/👎 feedback on results" />
            <Field label="Concurrency (parallel LLM calls)">
              <NumberInput value={s.concurrency} min={1} max={32} onCommit={(v) => save({ concurrency: Math.round(v) })} className="w-24" />
            </Field>
          </div>
        </Card>

        <Card title="Budget & defaults">
          <div className="flex flex-col gap-3">
            <Field label="Monthly budget cap (USD)" hint="Runs that would exceed this ask for confirmation.">
              <NumberInput value={s.monthlyBudgetUsd} min={0} step={1} onCommit={(v) => save({ monthlyBudgetUsd: v })} className="w-32" />
            </Field>
            <div className="flex items-end gap-2">
              <Field label="Default date range">
                <Select
                  value={s.defaultDateRange.preset}
                  onChange={(e) => save({ defaultDateRange: { ...s.defaultDateRange, preset: e.target.value as DatePreset } })}
                >
                  <option value="today">Today</option>
                  <option value="last7">Last 7 days</option>
                  <option value="last30">Last 30 days</option>
                  <option value="custom">Custom</option>
                </Select>
              </Field>
              {s.defaultDateRange.preset === 'custom' && (
                <>
                  <Input type="date" value={s.defaultDateRange.from ?? ''} onChange={(e) => save({ defaultDateRange: { ...s.defaultDateRange, from: e.target.value || null } })} />
                  <Input type="date" value={s.defaultDateRange.to ?? ''} onChange={(e) => save({ defaultDateRange: { ...s.defaultDateRange, to: e.target.value || null } })} />
                </>
              )}
            </div>
            <p className="text-xs text-slate-500">
              Default sources are saved from the Collect screen (“Save as default”); companies are managed in Settings → Companies. A budget of 0 means no cap.
            </p>
          </div>
        </Card>
      </div>

      <TaxonomyEditor settings={s} save={save} />
    </div>
  );
}
