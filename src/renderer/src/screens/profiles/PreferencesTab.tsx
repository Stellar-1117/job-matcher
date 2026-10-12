import { useEffect, useState, type ReactNode } from 'react';
import { HARD_FILTER_LABELS, SALARY_PERIODS, type HardFilterKey, type Preferences, type ProfileDetail } from '@shared/profile';
import { invoke, useIpc } from '../../api';
import { Button, Card, CheckboxGroup, ErrorBox, Field, Input, Select, TagInput, Textarea, Toggle, useAction } from '../../components/ui';

const withoutUnknown = (xs: string[]) => xs.filter((x) => x !== 'Unknown' && x !== 'Not mentioned');

function FilterRow({ k, enabled, onToggle, children }: { k: HardFilterKey; enabled: boolean; onToggle: (v: boolean) => void; children: ReactNode }) {
  const meta = HARD_FILTER_LABELS[k];
  return (
    <div className="grid grid-cols-[220px_1fr] gap-4 border-b border-slate-100 py-3 last:border-0">
      <div>
        <Toggle checked={enabled} onChange={onToggle} label={meta.label} />
        <p className="mt-1 text-xs text-slate-500">{meta.hint}</p>
      </div>
      <div className={enabled ? '' : 'opacity-50'}>{children}</div>
    </div>
  );
}

export default function PreferencesTab({ profile, onProfileChange }: { profile: ProfileDetail; onProfileChange: (p: ProfileDetail) => void }) {
  const [draft, setDraft] = useState<Preferences>(profile.preferences);
  useEffect(() => setDraft(profile.preferences), [profile.id, profile.preferences]);
  const settings = useIpc('settings:get', {});
  const activeResume = useIpc('resumes:get', { id: profile.activeResumeId ?? 0 }, [profile.activeResumeId]);
  const action = useAction();
  const tax = settings.data?.taxonomy;
  const dirty = JSON.stringify(draft) !== JSON.stringify(profile.preferences);

  const setHard = <K extends HardFilterKey>(k: K, patch: Partial<Preferences['hard'][K]>) =>
    setDraft((d) => ({ ...d, hard: { ...d.hard, [k]: { ...d.hard[k], ...patch } } }));
  const setSoft = <K extends keyof Preferences['soft']>(k: K, v: Preferences['soft'][K]) => setDraft((d) => ({ ...d, soft: { ...d.soft, [k]: v } }));

  const seniorityLevels = tax ? withoutUnknown(tax.seniority) : [];
  const h = draft.hard;
  const seniorityInvalid =
    h.seniority.min != null && h.seniority.max != null && seniorityLevels.indexOf(h.seniority.min) > seniorityLevels.indexOf(h.seniority.max);
  const resumeLanguages = activeResume.data?.structured?.languages ?? [];

  if (!tax) return <ErrorBox error={settings.error} />;

  return (
    <div className="flex flex-col gap-4">
      <div className="sticky top-0 z-10 flex items-center gap-2 rounded-md border border-slate-200 bg-white/95 px-4 py-2 shadow-sm backdrop-blur">
        <span className="text-sm text-slate-600">{dirty ? 'Unsaved changes' : 'All changes saved'}</span>
        {seniorityInvalid && <span className="text-sm text-red-600">Seniority minimum is above the maximum.</span>}
        <div className="ml-auto flex gap-2">
          {dirty && (
            <Button size="sm" onClick={() => setDraft(profile.preferences)}>
              Discard
            </Button>
          )}
          <Button
            size="sm"
            variant="primary"
            disabled={!dirty || action.busy || seniorityInvalid}
            onClick={() => action.run(async () => onProfileChange(await invoke('profiles:savePreferences', { id: profile.id, preferences: draft })))}
          >
            Save preferences
          </Button>
        </div>
      </div>
      <ErrorBox error={action.error} />

      <Card title="Hard filters">
        <p className="mb-1 text-sm text-slate-500">
          Checked in code before any LLM call — a job that fails an enabled filter is never scored. Jobs with missing information always pass.
        </p>
        <FilterRow k="location" enabled={h.location.enabled} onToggle={(v) => setHard('location', { enabled: v })}>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Allowed countries">
              <TagInput value={h.location.countries} onChange={(v) => setHard('location', { countries: v })} placeholder="e.g. United States, Canada" />
            </Field>
            <Field label="Allowed cities (optional)">
              <TagInput value={h.location.cities} onChange={(v) => setHard('location', { cities: v })} placeholder="e.g. New York, Toronto" />
            </Field>
          </div>
        </FilterRow>
        <FilterRow k="workModes" enabled={h.workModes.enabled} onToggle={(v) => setHard('workModes', { enabled: v })}>
          <CheckboxGroup options={withoutUnknown(tax.work_mode)} value={h.workModes.allowed} onChange={(v) => setHard('workModes', { allowed: v })} />
        </FilterRow>
        <FilterRow k="visa" enabled={h.visa.enabled} onToggle={(v) => setHard('visa', { enabled: v })}>
          <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={h.visa.needsSponsorship} onChange={() => setHard('visa', { needsSponsorship: true })} />I need visa sponsorship
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={!h.visa.needsSponsorship} onChange={() => setHard('visa', { needsSponsorship: false })} />I don't need sponsorship
            </label>
          </div>
        </FilterRow>
        <FilterRow k="salary" enabled={h.salary.enabled} onToggle={(v) => setHard('salary', { enabled: v })}>
          <div className="flex items-end gap-2">
            <Field label="Minimum">
              <Input
                type="number"
                min={0}
                step={1000}
                className="w-40"
                value={h.salary.min ?? ''}
                onChange={(e) => setHard('salary', { min: e.target.value === '' ? null : Math.max(0, Number(e.target.value)) })}
              />
            </Field>
            <Field label="Currency">
              <Input className="w-20 uppercase" maxLength={3} value={h.salary.currency} onChange={(e) => setHard('salary', { currency: e.target.value.toUpperCase().replace(/[^A-Z]/g, '') })} />
            </Field>
            <Field label="Per">
              <Select value={h.salary.period} onChange={(e) => setHard('salary', { period: e.target.value as Preferences['hard']['salary']['period'] })}>
                {SALARY_PERIODS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </FilterRow>
        <FilterRow k="seniority" enabled={h.seniority.enabled} onToggle={(v) => setHard('seniority', { enabled: v })}>
          <div className="flex items-end gap-2">
            <Field label="From">
              <Select value={h.seniority.min ?? ''} onChange={(e) => setHard('seniority', { min: e.target.value || null })}>
                <option value="">Any</option>
                {seniorityLevels.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </Field>
            <span className="pb-2 text-slate-400">to</span>
            <Field label="To">
              <Select value={h.seniority.max ?? ''} onChange={(e) => setHard('seniority', { max: e.target.value || null })}>
                <option value="">Any</option>
                {seniorityLevels.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </FilterRow>
        <FilterRow k="employmentTypes" enabled={h.employmentTypes.enabled} onToggle={(v) => setHard('employmentTypes', { enabled: v })}>
          <CheckboxGroup options={withoutUnknown(tax.employment_type)} value={h.employmentTypes.allowed} onChange={(v) => setHard('employmentTypes', { allowed: v })} />
        </FilterRow>
        <FilterRow k="dealBreakers" enabled={h.dealBreakers.enabled} onToggle={(v) => setHard('dealBreakers', { enabled: v })}>
          <TagInput value={h.dealBreakers.keywords} onChange={(v) => setHard('dealBreakers', { keywords: v })} placeholder="e.g. clearance required, crypto, 24/7 on-call" />
        </FilterRow>
        <FilterRow k="languages" enabled={h.languages.enabled} onToggle={(v) => setHard('languages', { enabled: v })}>
          <div className="flex items-start gap-2">
            <div className="flex-1">
              <TagInput value={h.languages.spoken} onChange={(v) => setHard('languages', { spoken: v })} placeholder="e.g. English, German" />
            </div>
            {resumeLanguages.length > 0 && (
              <Button size="sm" onClick={() => setHard('languages', { spoken: [...new Set([...h.languages.spoken, ...resumeLanguages])] })} title={resumeLanguages.join(', ')}>
                Add from resume
              </Button>
            )}
          </div>
        </FilterRow>
      </Card>

      <Card title="Soft preferences">
        <p className="mb-3 text-sm text-slate-500">Given to the matching model and scored as “preferences fit” — they never filter jobs out.</p>
        <div className="flex flex-col gap-4">
          <Field label="Target job functions">
            <CheckboxGroup options={tax.job_function} value={draft.soft.targetFunctions} onChange={(v) => setSoft('targetFunctions', v)} />
          </Field>
          <Field label="Preferred industries">
            <CheckboxGroup options={tax.industry} value={draft.soft.preferredIndustries} onChange={(v) => setSoft('preferredIndustries', v)} />
          </Field>
          <Field label="Preferred company stages">
            <CheckboxGroup options={withoutUnknown(tax.company_stage)} value={draft.soft.preferredStages} onChange={(v) => setSoft('preferredStages', v)} />
          </Field>
          <Field label="Industries to avoid">
            <CheckboxGroup options={tax.industry} value={draft.soft.avoidIndustries} onChange={(v) => setSoft('avoidIndustries', v)} />
          </Field>
          <Field label="Notes for the matcher">
            <Textarea rows={4} value={draft.soft.notes} onChange={(e) => setSoft('notes', e.target.value)} placeholder="Anything else that matters: team size, product type, travel, growth goals…" />
          </Field>
        </div>
      </Card>
    </div>
  );
}
