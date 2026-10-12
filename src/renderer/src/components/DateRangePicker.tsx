import type { DatePreset, DateRange } from '@shared/settings';
import { Input, cx } from './ui';

const PRESETS: { key: DatePreset; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'last7', label: 'Last 7 days' },
  { key: 'last30', label: 'Last 30 days' },
  { key: 'custom', label: 'Custom' },
];

export default function DateRangePicker({ value, onChange }: { value: DateRange; onChange: (v: DateRange) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex overflow-hidden rounded-md border border-slate-300">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => onChange({ ...value, preset: p.key })}
            className={cx(
              'border-r border-slate-300 px-3 py-1.5 text-sm last:border-r-0',
              value.preset === p.key ? 'bg-indigo-600 text-white' : 'bg-white text-slate-700 hover:bg-slate-50',
            )}
          >
            {p.label}
          </button>
        ))}
      </div>
      {value.preset === 'custom' && (
        <span className="flex items-center gap-1.5 text-sm text-slate-600">
          <Input type="date" value={value.from ?? ''} onChange={(e) => onChange({ ...value, from: e.target.value || null })} />
          to
          <Input type="date" value={value.to ?? ''} onChange={(e) => onChange({ ...value, to: e.target.value || null })} />
        </span>
      )}
    </div>
  );
}
