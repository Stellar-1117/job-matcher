import { useEffect, useId, useState, type Ref, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'dangerSolid' | 'dangerGhost' | 'ghost';

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  ref,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'sm' | 'md'; ref?: Ref<HTMLButtonElement> }) {
  const variants: Record<ButtonVariant, string> = {
    primary: 'bg-indigo-600 text-white hover:bg-indigo-700 border-indigo-600',
    secondary: 'bg-white text-slate-700 hover:bg-slate-50 border-slate-300',
    danger: 'bg-white text-red-600 hover:bg-red-50 border-red-300',
    dangerSolid: 'bg-red-600 text-white hover:bg-red-700 border-red-600',
    dangerGhost: 'bg-transparent text-red-600 hover:bg-red-50 border-transparent',
    ghost: 'bg-transparent text-slate-600 hover:bg-slate-100 border-transparent',
  };
  return (
    <button
      ref={ref}
      type="button"
      {...props}
      className={cx(
        'inline-flex items-center gap-1.5 rounded-md border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-sm',
        variants[variant],
        className,
      )}
    />
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cx(
        'rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 disabled:bg-slate-100',
        className,
      )}
    />
  );
}

/** Number input that keeps a local string while typing and commits a number on blur. */
export function NumberInput({
  value,
  onCommit,
  className,
  step,
  min,
  max,
}: {
  value: number;
  onCommit: (v: number) => void;
  className?: string;
  step?: number;
  min?: number;
  max?: number;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <Input
      type="number"
      className={className}
      value={text}
      step={step}
      min={min}
      max={max}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const n = Number(text);
        if (text.trim() !== '' && Number.isFinite(n)) onCommit(n);
        else setText(String(value));
      }}
    />
  );
}

export function Textarea({ className, ref, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> }) {
  return (
    <textarea
      ref={ref}
      {...props}
      className={cx(
        'w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100',
        className,
      )}
    />
  );
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={cx(
        'rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 disabled:bg-slate-100',
        className,
      )}
    >
      {children}
    </select>
  );
}

export function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <label className={cx('inline-flex items-center gap-2', disabled ? 'opacity-50' : 'cursor-pointer')}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx('relative h-5 w-9 rounded-full transition-colors', checked ? 'bg-indigo-600' : 'bg-slate-300')}
      >
        <span className={cx('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all', checked ? 'left-[18px]' : 'left-0.5')} />
      </button>
      {label && <span className="text-sm">{label}</span>}
    </label>
  );
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('rounded-lg border border-slate-200 bg-white shadow-sm', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
          <h3 className="font-semibold text-slate-800">{title}</h3>
          <div className="flex items-center gap-2">{actions}</div>
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Badge({ children, tone = 'slate' }: { children: ReactNode; tone?: 'slate' | 'green' | 'amber' | 'red' | 'indigo' | 'blue' }) {
  const tones = {
    slate: 'bg-slate-100 text-slate-700',
    green: 'bg-emerald-100 text-emerald-800',
    amber: 'bg-amber-100 text-amber-800',
    red: 'bg-red-100 text-red-700',
    indigo: 'bg-indigo-100 text-indigo-700',
    blue: 'bg-sky-100 text-sky-800',
  };
  return <span className={cx('inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium', tones[tone])}>{children}</span>;
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-slate-600">{label}</span>
      {children}
      {hint && <span className="text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

export function ErrorBox({ error }: { error: string | null }) {
  if (!error) return null;
  return <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>;
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { key: T; label: string }[]; value: T; onChange: (k: T) => void }) {
  return (
    <div className="flex gap-1 border-b border-slate-200">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={() => onChange(t.key)}
          className={cx(
            '-mb-px border-b-2 px-3 py-2 text-sm font-medium',
            value === t.key ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-slate-500 hover:text-slate-700',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** Run an async action with busy/error state. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError((e as Error).message);
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run, setError };
}

/** Chips input for string lists: Enter or comma adds, Backspace removes the last, paste splits on commas/newlines. */
export function TagInput({
  value,
  onChange,
  placeholder,
  disabled,
  suggestions,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
  suggestions?: string[];
}) {
  const [text, setText] = useState('');
  const listId = useId();
  const add = (raw: string) => {
    const parts = raw
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!parts.length) return;
    const lower = new Set(value.map((v) => v.toLowerCase()));
    const next = [...value];
    for (const p of parts) {
      if (!lower.has(p.toLowerCase())) {
        next.push(p);
        lower.add(p.toLowerCase());
      }
    }
    onChange(next);
    setText('');
  };
  return (
    <div
      className={cx(
        'flex min-h-[34px] flex-wrap items-center gap-1 rounded-md border border-slate-300 bg-white px-1.5 py-1 focus-within:border-indigo-500 focus-within:ring-2 focus-within:ring-indigo-100',
        disabled && 'bg-slate-100 opacity-70',
      )}
    >
      {value.map((v) => (
        <span key={v} className="inline-flex items-center gap-1 rounded bg-indigo-50 px-1.5 py-0.5 text-xs text-indigo-800">
          {v}
          {!disabled && (
            <button type="button" className="text-indigo-400 hover:text-indigo-700" onClick={() => onChange(value.filter((x) => x !== v))} aria-label={`Remove ${v}`}>
              ×
            </button>
          )}
        </span>
      ))}
      <input
        className="min-w-24 flex-1 border-0 bg-transparent px-1 py-0.5 text-sm outline-none"
        value={text}
        disabled={disabled}
        list={suggestions ? listId : undefined}
        placeholder={value.length ? '' : placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            add(text);
          } else if (e.key === 'Backspace' && !text && value.length) {
            onChange(value.slice(0, -1));
          }
        }}
        onPaste={(e) => {
          const t = e.clipboardData.getData('text');
          if (/[,\n]/.test(t)) {
            e.preventDefault();
            add(t);
          }
        }}
        onBlur={() => add(text)}
      />
      {suggestions && (
        <datalist id={listId}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </div>
  );
}

export function CheckboxGroup({ options, value, onChange, disabled }: { options: string[]; value: string[]; onChange: (v: string[]) => void; disabled?: boolean }) {
  return (
    <div className={cx('flex flex-wrap gap-x-4 gap-y-1.5', disabled && 'opacity-60')}>
      {options.map((o) => (
        <label key={o} className="flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            disabled={disabled}
            checked={value.includes(o)}
            onChange={(e) => onChange(e.target.checked ? [...value, o] : value.filter((x) => x !== o))}
          />
          {o}
        </label>
      ))}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <span className={cx('inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-indigo-200 border-t-indigo-600', className)} />;
}
