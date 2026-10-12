import { useMemo, useState, type ReactNode } from 'react';
import { DEFAULT_FILTERS, FACETS, activeFilterCount, facetCounts, type FacetKey, type ResultFilters, type ScoredRow } from '@shared/resultFilters';
import { JOB_STATUSES, JOB_STATUS_LABELS } from '@shared/results';
import { VERDICT_LABELS, type Verdict } from '@shared/scoring';
import { Button, Input, NumberInput, Select, Toggle, cx } from '../../components/ui';

const VERDICTS: Verdict[] = ['strong', 'good', 'stretch', 'skip'];

function Section({ title, count, defaultOpen, children }: { title: string; count?: number; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  return (
    <div className="border-b border-slate-200 py-2">
      <button type="button" className="flex w-full items-center gap-1.5 text-left text-xs font-semibold uppercase tracking-wide text-slate-600" onClick={() => setOpen((v) => !v)}>
        <span className="w-3 text-slate-400">{open ? '▾' : '▸'}</span>
        {title}
        {!!count && <span className="ml-auto rounded bg-indigo-100 px-1.5 text-[10px] text-indigo-700">{count}</span>}
      </button>
      {open && <div className="mt-2 pl-4">{children}</div>}
    </div>
  );
}

function CheckList({
  options,
  value,
  onChange,
  searchable,
}: {
  options: { value: string; label?: string; count?: number }[];
  value: string[];
  onChange: (v: string[]) => void;
  searchable?: boolean;
}) {
  const [q, setQ] = useState('');
  const [all, setAll] = useState(false);
  const selected = new Set(value.map((v) => v.toLowerCase()));
  let shown = q ? options.filter((o) => (o.label ?? o.value).toLowerCase().includes(q.toLowerCase())) : options;
  const limit = 12;
  const more = !all && shown.length > limit ? shown.length - limit : 0;
  if (more) shown = [...shown.slice(0, limit), ...shown.slice(limit).filter((o) => selected.has(o.value.toLowerCase()))];
  const toggle = (v: string) => onChange(selected.has(v.toLowerCase()) ? value.filter((x) => x.toLowerCase() !== v.toLowerCase()) : [...value, v]);
  if (!options.length) return <p className="text-xs text-slate-400">No values</p>;
  return (
    <div className="flex flex-col gap-0.5">
      {searchable && options.length > limit && <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" className="mb-1 py-0.5 text-xs" />}
      {shown.map((o) => (
        <label key={o.value} className="flex items-center gap-1.5 text-xs">
          <input type="checkbox" checked={selected.has(o.value.toLowerCase())} onChange={() => toggle(o.value)} />
          <span className="min-w-0 flex-1 truncate" title={o.label ?? o.value}>
            {o.label ?? o.value}
          </span>
          {o.count != null && <span className="text-slate-400 tabular-nums">{o.count}</span>}
        </label>
      ))}
      {more > 0 && (
        <button type="button" className="mt-0.5 text-left text-xs text-indigo-600 hover:underline" onClick={() => setAll(true)}>
          Show {more} more
        </button>
      )}
    </div>
  );
}

export default function FilterSidebar({
  rows,
  filters,
  onChange,
}: {
  /** All rows of the profile (facet counts come from these). */
  rows: ScoredRow[];
  filters: ResultFilters;
  onChange: (f: ResultFilters) => void;
}) {
  const set = <K extends keyof ResultFilters>(k: K, v: ResultFilters[K]) => onChange({ ...filters, [k]: v });
  const setFacet = (k: FacetKey, v: string[]) => onChange({ ...filters, facets: { ...filters.facets, [k]: v } });
  const facetOptions = useMemo(() => Object.fromEntries(FACETS.map((f) => [f.key, facetCounts(rows, f.key)])) as Record<FacetKey, { value: string; count: number }[]>, [rows]);
  const sources = useMemo(() => {
    const m = new Map<string, { value: string; label: string; count: number }>();
    for (const r of rows) {
      const e = m.get(r.sourceKey) ?? { value: r.sourceKey, label: r.sourceLabel, count: 0 };
      e.count++;
      m.set(r.sourceKey, e);
    }
    return [...m.values()].sort((a, b) => b.count - a.count);
  }, [rows]);
  const verdictCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of rows) if (r.verdict) c[r.verdict] = (c[r.verdict] ?? 0) + 1;
    return c;
  }, [rows]);
  const statusCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of rows) c[r.status] = (c[r.status] ?? 0) + 1;
    return c;
  }, [rows]);
  const currencies = useMemo(() => [...new Set(rows.map((r) => r.fields?.salary_currency).filter((c): c is string => !!c))].sort(), [rows]);
  const active = activeFilterCount(filters);

  return (
    <aside className="flex w-60 shrink-0 flex-col overflow-y-auto border-r border-slate-200 bg-white px-3 py-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-semibold text-slate-700">Filters</span>
        {active > 0 && (
          <Button size="sm" variant="ghost" onClick={() => onChange(DEFAULT_FILTERS)}>
            Clear ({active})
          </Button>
        )}
      </div>
      <Input value={filters.search} onChange={(e) => set('search', e.target.value)} placeholder="Search title, company, summary…" className="mb-2 text-xs" />

      <div className="flex flex-col gap-1.5 border-b border-slate-200 pb-3">
        <Toggle checked={filters.hideClosed} onChange={(v) => set('hideClosed', v)} label="Hide closed jobs" />
        <Toggle checked={filters.hideReviewedRejected} onChange={(v) => set('hideReviewedRejected', v)} label="Hide reviewed / rejected" />
        <Toggle checked={filters.showHardFiltered} onChange={(v) => set('showHardFiltered', v)} label="Show hard-filter failures" />
      </div>

      <div className="border-b border-slate-200 py-2">
        <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-slate-600">
          Minimum score <span className="font-mono text-sm normal-case text-slate-800">{filters.minScore}</span>
        </div>
        <input type="range" min={0} max={100} step={1} value={filters.minScore} onChange={(e) => set('minScore', Number(e.target.value))} className="mt-1 w-full accent-indigo-600" />
      </div>

      <Section title="Verdict" count={filters.verdicts.length} defaultOpen>
        <CheckList options={VERDICTS.map((v) => ({ value: v, label: VERDICT_LABELS[v], count: verdictCounts[v] ?? 0 }))} value={filters.verdicts} onChange={(v) => set('verdicts', v as Verdict[])} />
      </Section>
      <Section title="Status" count={filters.statuses.length} defaultOpen>
        <CheckList
          options={JOB_STATUSES.map((s) => ({ value: s, label: JOB_STATUS_LABELS[s], count: statusCounts[s] ?? 0 }))}
          value={filters.statuses}
          onChange={(v) => set('statuses', v as ResultFilters['statuses'])}
        />
      </Section>
      <Section title="Posted" count={filters.date.preset !== 'any' ? 1 : 0}>
        <Select value={filters.date.preset} onChange={(e) => set('date', { ...filters.date, preset: e.target.value as ResultFilters['date']['preset'] })} className="w-full text-xs">
          <option value="any">Any time</option>
          <option value="today">Today</option>
          <option value="last7">Last 7 days</option>
          <option value="last30">Last 30 days</option>
          <option value="custom">Custom…</option>
        </Select>
        {filters.date.preset === 'custom' && (
          <div className="mt-1 flex flex-col gap-1">
            <Input type="date" value={filters.date.from ?? ''} onChange={(e) => set('date', { ...filters.date, from: e.target.value || null })} className="text-xs" />
            <Input type="date" value={filters.date.to ?? ''} onChange={(e) => set('date', { ...filters.date, to: e.target.value || null })} className="text-xs" />
          </div>
        )}
        <p className="mt-1 text-[11px] text-slate-400">Posting date when known, else first seen.</p>
      </Section>
      <Section title="Source" count={filters.sources.length}>
        <CheckList options={sources} value={filters.sources} onChange={(v) => set('sources', v)} />
      </Section>
      <Section title="Salary" count={(filters.salaryListedOnly ? 1 : 0) + (filters.minSalary != null ? 1 : 0)}>
        <div className="flex flex-col gap-1.5">
          <label className="flex items-center gap-1.5 text-xs">
            <input type="checkbox" checked={filters.salaryListedOnly} onChange={(e) => set('salaryListedOnly', e.target.checked)} />
            Only jobs with a listed salary
          </label>
          <span className="text-xs text-slate-600">At least (per year)</span>
          <div className="flex gap-1">
            <NumberInput value={filters.minSalary ?? 0} min={0} step={5000} onCommit={(v) => set('minSalary', v > 0 ? v : null)} className="w-24 py-0.5 text-xs" />
            <Select value={filters.salaryCurrency ?? ''} onChange={(e) => set('salaryCurrency', e.target.value || null)} className="py-0.5 text-xs">
              <option value="">Any currency</option>
              {currencies.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </Section>
      <Section title="Required experience" count={filters.maxYears != null ? 1 : 0}>
        <span className="text-xs text-slate-600">Requires at most (years)</span>
        <NumberInput value={filters.maxYears ?? 0} min={0} max={40} onCommit={(v) => set('maxYears', v > 0 ? Math.round(v) : null)} className="mt-1 w-20 py-0.5 text-xs" />
        <p className="mt-1 text-[11px] text-slate-400">0 = no limit. Jobs that don't state years always pass.</p>
      </Section>
      {FACETS.map((f) => (
        <Section key={f.key} title={f.label} count={filters.facets[f.key]?.length ?? 0}>
          <CheckList options={facetOptions[f.key]} value={filters.facets[f.key] ?? []} onChange={(v) => setFacet(f.key, v)} searchable={f.list || facetOptions[f.key].length > 12} />
        </Section>
      ))}
      <p className={cx('mt-3 text-[11px] text-slate-400')}>Fields come from job extraction. "Unknown" means the posting didn't say.</p>
    </aside>
  );
}
