import { useEffect, useState } from 'react';
import type { ResumeParsed } from '@shared/llm-schemas';
import { Button, Card, Field, Input, TagInput, Textarea } from '../../components/ui';

type Role = ResumeParsed['roles'][number];
type Project = ResumeParsed['projects'][number];
type Education = ResumeParsed['education'][number];

const EMPTY_ROLE: Role = { title: '', company: null, start: null, end: null, summary: null };
const EMPTY_PROJECT: Project = { name: '', role: null, what_built: '', scale_impact: null, technologies: [], domain: null };
const EMPTY_EDU: Education = { degree: null, institution: null, year: null };

const orNull = (s: string) => (s.trim() ? s : null);

/** Editable view of the parsed resume, so the user can correct what the model extracted. */
export default function StructuredEditor({
  value,
  edited,
  busy,
  onSave,
  onRevert,
}: {
  value: ResumeParsed;
  edited: boolean;
  busy: boolean;
  onSave: (v: ResumeParsed) => void;
  onRevert: () => void;
}) {
  const [draft, setDraft] = useState<ResumeParsed>(value);
  useEffect(() => setDraft(value), [value]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(value);
  const set = <K extends keyof ResumeParsed>(k: K, v: ResumeParsed[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const setItem = <K extends 'roles' | 'projects' | 'education'>(k: K, i: number, patch: Partial<ResumeParsed[K][number]>) =>
    setDraft((d) => ({ ...d, [k]: d[k].map((x, j) => (j === i ? { ...x, ...patch } : x)) }));
  const removeItem = (k: 'roles' | 'projects' | 'education', i: number) => setDraft((d) => ({ ...d, [k]: d[k].filter((_, j) => j !== i) }));

  return (
    <div className="flex flex-col gap-4">
      <div className="sticky top-0 z-10 -mx-1 flex items-center gap-2 rounded-md bg-slate-50/95 px-1 py-2 backdrop-blur">
        <span className="text-sm text-slate-600">{dirty ? 'Unsaved changes' : edited ? 'Includes your manual corrections' : 'As parsed by the model'}</span>
        <div className="ml-auto flex gap-2">
          {dirty && (
            <Button size="sm" onClick={() => setDraft(value)}>
              Discard
            </Button>
          )}
          {edited && !dirty && (
            <Button size="sm" onClick={onRevert} disabled={busy}>
              Revert to parsed
            </Button>
          )}
          <Button size="sm" variant="primary" disabled={!dirty || busy} onClick={() => onSave(draft)}>
            Save corrections
          </Button>
        </div>
      </div>

      <Card title="Summary">
        <div className="grid grid-cols-[1fr_2fr_140px] gap-3">
          <Field label="Name">
            <Input value={draft.name ?? ''} onChange={(e) => set('name', orNull(e.target.value))} />
          </Field>
          <Field label="Headline">
            <Input value={draft.headline ?? ''} onChange={(e) => set('headline', orNull(e.target.value))} />
          </Field>
          <Field label="Total years">
            <Input
              type="number"
              min={0}
              step={0.5}
              value={draft.total_years_experience ?? ''}
              onChange={(e) => set('total_years_experience', e.target.value === '' ? null : Number(e.target.value))}
            />
          </Field>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3">
          <Field label="Skills">
            <TagInput value={draft.skills} onChange={(v) => set('skills', v)} placeholder="Add a skill and press Enter" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Domains">
              <TagInput value={draft.domains} onChange={(v) => set('domains', v)} placeholder="e.g. payments" />
            </Field>
            <Field label="Languages spoken">
              <TagInput value={draft.languages} onChange={(v) => set('languages', v)} placeholder="e.g. English" />
            </Field>
          </div>
        </div>
      </Card>

      <Card
        title={`Roles (${draft.roles.length})`}
        actions={
          <Button size="sm" onClick={() => set('roles', [...draft.roles, EMPTY_ROLE])}>
            Add role
          </Button>
        }
      >
        <div className="flex flex-col gap-3">
          {draft.roles.map((r, i) => (
            <div key={i} className="rounded-md border border-slate-200 p-3">
              <div className="grid grid-cols-[2fr_2fr_110px_110px_auto] items-end gap-2">
                <Field label="Title">
                  <Input value={r.title} onChange={(e) => setItem('roles', i, { title: e.target.value })} />
                </Field>
                <Field label="Company">
                  <Input value={r.company ?? ''} onChange={(e) => setItem('roles', i, { company: orNull(e.target.value) })} />
                </Field>
                <Field label="Start">
                  <Input value={r.start ?? ''} placeholder="YYYY-MM" onChange={(e) => setItem('roles', i, { start: orNull(e.target.value) })} />
                </Field>
                <Field label="End">
                  <Input value={r.end ?? ''} placeholder="present" onChange={(e) => setItem('roles', i, { end: orNull(e.target.value) })} />
                </Field>
                <Button size="sm" variant="dangerGhost" className="mb-1" onClick={() => removeItem('roles', i)}>
                  Remove
                </Button>
              </div>
              <Textarea className="mt-2 text-xs" rows={2} value={r.summary ?? ''} placeholder="Summary" onChange={(e) => setItem('roles', i, { summary: orNull(e.target.value) })} />
            </div>
          ))}
          {!draft.roles.length && <p className="text-sm text-slate-500">No roles.</p>}
        </div>
      </Card>

      <Card
        title={`Projects (${draft.projects.length})`}
        actions={
          <Button size="sm" onClick={() => set('projects', [...draft.projects, EMPTY_PROJECT])}>
            Add project
          </Button>
        }
      >
        <div className="flex flex-col gap-3">
          {draft.projects.map((p, i) => (
            <div key={i} className="rounded-md border border-slate-200 p-3">
              <div className="grid grid-cols-[2fr_1.5fr_1.5fr_auto] items-end gap-2">
                <Field label="Name">
                  <Input value={p.name} onChange={(e) => setItem('projects', i, { name: e.target.value })} />
                </Field>
                <Field label="Role">
                  <Input value={p.role ?? ''} onChange={(e) => setItem('projects', i, { role: orNull(e.target.value) })} />
                </Field>
                <Field label="Domain">
                  <Input value={p.domain ?? ''} onChange={(e) => setItem('projects', i, { domain: orNull(e.target.value) })} />
                </Field>
                <Button size="sm" variant="dangerGhost" className="mb-1" onClick={() => removeItem('projects', i)}>
                  Remove
                </Button>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <Field label="What was built">
                  <Textarea className="text-xs" rows={2} value={p.what_built} onChange={(e) => setItem('projects', i, { what_built: e.target.value })} />
                </Field>
                <Field label="Scale / impact">
                  <Textarea className="text-xs" rows={2} value={p.scale_impact ?? ''} onChange={(e) => setItem('projects', i, { scale_impact: orNull(e.target.value) })} />
                </Field>
              </div>
              <div className="mt-2">
                <Field label="Technologies">
                  <TagInput value={p.technologies} onChange={(v) => setItem('projects', i, { technologies: v })} />
                </Field>
              </div>
            </div>
          ))}
          {!draft.projects.length && <p className="text-sm text-slate-500">No projects.</p>}
        </div>
      </Card>

      <Card
        title={`Education (${draft.education.length})`}
        actions={
          <Button size="sm" onClick={() => set('education', [...draft.education, EMPTY_EDU])}>
            Add
          </Button>
        }
      >
        <div className="flex flex-col gap-2">
          {draft.education.map((e, i) => (
            <div key={i} className="grid grid-cols-[2fr_2fr_100px_auto] items-end gap-2">
              <Field label="Degree">
                <Input value={e.degree ?? ''} onChange={(ev) => setItem('education', i, { degree: orNull(ev.target.value) })} />
              </Field>
              <Field label="Institution">
                <Input value={e.institution ?? ''} onChange={(ev) => setItem('education', i, { institution: orNull(ev.target.value) })} />
              </Field>
              <Field label="Year">
                <Input value={e.year ?? ''} onChange={(ev) => setItem('education', i, { year: orNull(ev.target.value) })} />
              </Field>
              <Button size="sm" variant="dangerGhost" className="mb-1" onClick={() => removeItem('education', i)}>
                Remove
              </Button>
            </div>
          ))}
          {!draft.education.length && <p className="text-sm text-slate-500">No education entries.</p>}
        </div>
      </Card>
    </div>
  );
}
