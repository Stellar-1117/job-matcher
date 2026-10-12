import { useEffect, useMemo, useState } from 'react';
import { diffLines } from 'diff';
import { TASKS, TASK_META, TEMPLATE_VARIABLES, type TaskKey } from '@shared/tasks';
import type { PromptVersion } from '@shared/types';
import { invoke, useIpc } from '../../api';
import { Badge, Button, Card, ErrorBox, Input, Select, Textarea, cx, useAction } from '../../components/ui';

const VAR_RE = /\{\{\s*([a-z_]+)\s*\}\}/g;

function usedVariables(text: string): string[] {
  return [...new Set([...text.matchAll(VAR_RE)].map((m) => m[1]))];
}

function DiffView({ a, b }: { a: PromptVersion; b: PromptVersion }) {
  const parts = useMemo(() => diffLines(a.content, b.content), [a, b]);
  return (
    <pre className="max-h-[60vh] overflow-auto rounded-md border border-slate-200 bg-white p-3 font-mono text-xs leading-5">
      {parts.map((p, i) => (
        <span key={i} className={cx(p.added && 'block bg-emerald-100 text-emerald-900', p.removed && 'block bg-red-100 text-red-800 line-through decoration-red-300')}>
          {p.value
            .replace(/\n$/, '')
            .split('\n')
            .map((line) => `${p.added ? '+ ' : p.removed ? '- ' : '  '}${line}`)
            .join('\n')}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}

export default function PromptsTab() {
  const [task, setTask] = useState<TaskKey>('matching');
  const prompts = useIpc('prompts:list', { task }, [task]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [draftNotes, setDraftNotes] = useState('');
  const [activateOnSave, setActivateOnSave] = useState(true);
  const [mode, setMode] = useState<'edit' | 'diff'>('edit');
  const [diffA, setDiffA] = useState<number | null>(null);
  const [diffB, setDiffB] = useState<number | null>(null);
  const [notesEdit, setNotesEdit] = useState('');
  const action = useAction();

  const versions = prompts.data ?? [];
  const selected = versions.find((v) => v.id === selectedId) ?? versions.find((v) => v.is_active) ?? versions[0] ?? null;

  useEffect(() => {
    setSelectedId(null);
    setMode('edit');
  }, [task]);

  useEffect(() => {
    if (selected) {
      setDraft(selected.content);
      setNotesEdit(selected.notes);
      setDraftNotes('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  useEffect(() => {
    if (versions.length >= 2 && (diffA == null || !versions.some((v) => v.id === diffA))) {
      setDiffA(versions[1].id);
      setDiffB(versions[0].id);
    }
  }, [versions, diffA]);

  const dirty = selected != null && draft !== selected.content;
  const vars = usedVariables(draft);
  const unknown = vars.filter((v) => !(TEMPLATE_VARIABLES as readonly string[]).includes(v));
  const missingSchema = !vars.includes('output_schema');

  const saveVersion = () =>
    action.run(async () => {
      const list = await invoke('prompts:create', { task, content: draft, notes: draftNotes, activate: activateOnSave });
      prompts.set(list);
      setSelectedId(list[0].id);
    });

  return (
    <div className="grid grid-cols-[200px_240px_1fr] gap-4">
      <Card title="Task" className="h-fit">
        <div className="flex flex-col gap-0.5">
          {TASKS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTask(t)}
              className={cx('rounded-md px-2 py-1.5 text-left text-sm', t === task ? 'bg-indigo-50 font-medium text-indigo-700' : 'hover:bg-slate-100')}
            >
              {TASK_META[t].label}
            </button>
          ))}
        </div>
      </Card>

      <Card title="Versions" className="h-fit">
        <div className="flex flex-col gap-1">
          {versions.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => {
                setSelectedId(v.id);
                setMode('edit');
              }}
              className={cx(
                'rounded-md border px-2 py-1.5 text-left',
                selected?.id === v.id && mode === 'edit' ? 'border-indigo-300 bg-indigo-50' : 'border-transparent hover:bg-slate-50',
              )}
            >
              <div className="flex items-center gap-2">
                <span className="font-medium">v{v.version}</span>
                {v.is_active && <Badge tone="green">active</Badge>}
              </div>
              <div className="truncate text-xs text-slate-500">{v.notes || '—'}</div>
              <div className="text-[11px] text-slate-400">{new Date(v.created_at).toLocaleString()}</div>
            </button>
          ))}
        </div>
        {versions.length >= 2 && (
          <Button size="sm" className="mt-3 w-full justify-center" onClick={() => setMode('diff')}>
            Compare versions
          </Button>
        )}
      </Card>

      <div className="flex min-w-0 flex-col gap-4">
        <ErrorBox error={prompts.error ?? action.error} />
        {mode === 'diff' ? (
          <Card
            title="Diff"
            actions={
              <div className="flex items-center gap-2 text-sm">
                <Select value={diffA ?? ''} onChange={(e) => setDiffA(Number(e.target.value))}>
                  {versions.map((v) => (
                    <option key={v.id} value={v.id}>
                      v{v.version}
                    </option>
                  ))}
                </Select>
                →
                <Select value={diffB ?? ''} onChange={(e) => setDiffB(Number(e.target.value))}>
                  {versions.map((v) => (
                    <option key={v.id} value={v.id}>
                      v{v.version}
                    </option>
                  ))}
                </Select>
                <Button size="sm" onClick={() => setMode('edit')}>
                  Close
                </Button>
              </div>
            }
          >
            {diffA != null && diffB != null && (
              <DiffView a={versions.find((v) => v.id === diffA)!} b={versions.find((v) => v.id === diffB)!} />
            )}
          </Card>
        ) : (
          selected && (
            <Card
              title={
                <span className="flex items-center gap-2">
                  {TASK_META[task].label} · v{selected.version}
                  {selected.is_active && <Badge tone="green">active</Badge>}
                  {dirty && <Badge tone="amber">edited — will save as v{versions[0].version + 1}</Badge>}
                </span>
              }
              actions={
                !selected.is_active &&
                !dirty && (
                  <Button size="sm" variant="primary" disabled={action.busy} onClick={() => action.run(async () => prompts.set(await invoke('prompts:setActive', { id: selected.id })))}>
                    Set active
                  </Button>
                )
              }
            >
              <div className="mb-3 flex items-end gap-2">
                <label className="flex flex-1 flex-col gap-1">
                  <span className="text-xs font-medium text-slate-600">Notes for v{selected.version}</span>
                  <Input value={notesEdit} onChange={(e) => setNotesEdit(e.target.value)} />
                </label>
                <Button
                  size="md"
                  disabled={action.busy || notesEdit === selected.notes}
                  onClick={() => action.run(async () => prompts.set(await invoke('prompts:updateNotes', { id: selected.id, notes: notesEdit })))}
                >
                  Save notes
                </Button>
              </div>

              <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={24} spellCheck={false} className="font-mono text-xs leading-5" />

              <div className="mt-2 flex flex-wrap gap-1 text-xs">
                <span className="text-slate-500">Variables:</span>
                {TEMPLATE_VARIABLES.map((v) => (
                  <code key={v} className={cx('rounded px-1', vars.includes(v) ? 'bg-indigo-100 text-indigo-800' : 'bg-slate-100 text-slate-400')}>
                    {`{{${v}}}`}
                  </code>
                ))}
              </div>
              {unknown.length > 0 && <div className="mt-1 text-xs text-red-600">Unknown variables (left as-is): {unknown.join(', ')}</div>}
              {missingSchema && ['job_extraction', 'resume_parse', 'matching'].includes(task) && (
                <div className="mt-1 text-xs text-amber-700">
                  This prompt doesn't include {'{{output_schema}}'}. Output must still validate against the task's schema.
                </div>
              )}

              {dirty && (
                <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-slate-100 pt-3">
                  <label className="flex flex-1 flex-col gap-1">
                    <span className="text-xs font-medium text-slate-600">Notes for the new version</span>
                    <Input value={draftNotes} onChange={(e) => setDraftNotes(e.target.value)} placeholder="What changed?" />
                  </label>
                  <label className="flex items-center gap-1.5 pb-2 text-sm">
                    <input type="checkbox" checked={activateOnSave} onChange={(e) => setActivateOnSave(e.target.checked)} />
                    Set active
                  </label>
                  <Button variant="primary" disabled={action.busy || !draft.trim()} onClick={saveVersion}>
                    Save as v{versions[0].version + 1}
                  </Button>
                  <Button onClick={() => setDraft(selected.content)}>Discard</Button>
                </div>
              )}
            </Card>
          )
        )}
      </div>
    </div>
  );
}
