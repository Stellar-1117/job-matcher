import { useRef, useState } from 'react';
import type { ProfileDetail, ResumeDetail } from '@shared/profile';
import { PROVIDER_LABELS, type BuiltinProvider } from '@shared/types';
import { invoke, useIpc, useIpcEvent } from '../../api';
import { Badge, Button, Card, ErrorBox, Spinner, Textarea, cx, useAction } from '../../components/ui';
import StructuredEditor from './StructuredEditor';
import { useConfirm } from '../../components/confirm';

const STATUS: Record<string, { label: string; tone: 'slate' | 'blue' | 'green' | 'red' }> = {
  pending: { label: 'Not parsed', tone: 'slate' },
  parsing: { label: 'Parsing…', tone: 'blue' },
  done: { label: 'Parsed', tone: 'green' },
  failed: { label: 'Parse failed', tone: 'red' },
};

function UploadCard({ profile, onUploaded }: { profile: ProfileDetail; onUploaded: (r: ResumeDetail) => void }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [pasteMode, setPasteMode] = useState(false);
  const [pasted, setPasted] = useState('');
  const action = useAction();
  const routes = useIpc('routes:list', {});
  const models = useIpc('models:list', {});
  const keys = useIpc('keys:list', {});
  const route = routes.data?.find((r) => r.task === 'resume_parse');
  const model = models.data?.find((m) => m.id === route?.model_id);
  const provider = model
    ? keys.data?.find((k) => k.provider === model.provider)?.displayName ?? PROVIDER_LABELS[model.provider as BuiltinProvider] ?? model.provider
    : null;

  const upload = (file: File) =>
    action.run(async () => {
      const data = new Uint8Array(await file.arrayBuffer());
      onUploaded(await invoke('resumes:upload', { profileId: profile.id, fileName: file.name, data }));
    });

  return (
    <Card title={profile.resumes.length ? 'Upload a new resume version' : 'Upload a resume'}>
      {!pasteMode ? (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const f = e.dataTransfer.files[0];
            if (f) void upload(f);
          }}
          className={cx(
            'flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-6 text-center',
            dragging ? 'border-indigo-400 bg-indigo-50' : 'border-slate-300',
          )}
        >
          {action.busy ? (
            <span className="flex items-center gap-2 text-sm text-slate-600">
              <Spinner /> Reading file…
            </span>
          ) : (
            <>
              <span className="text-sm text-slate-600">Drop a PDF, DOCX or TXT file here, or</span>
              <div className="flex gap-2">
                <Button variant="primary" onClick={() => fileInput.current?.click()}>
                  Choose file
                </Button>
                <Button onClick={() => setPasteMode(true)}>Paste text instead</Button>
              </div>
            </>
          )}
          <input
            ref={fileInput}
            type="file"
            accept=".pdf,.docx,.txt,.md"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void upload(f);
            }}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <Textarea rows={10} value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="Paste the full resume text" className="font-mono text-xs" />
          <div className="flex gap-2">
            <Button
              variant="primary"
              disabled={action.busy || !pasted.trim()}
              onClick={() =>
                action.run(async () => {
                  onUploaded(await invoke('resumes:pasteText', { profileId: profile.id, text: pasted }));
                  setPasted('');
                  setPasteMode(false);
                })
              }
            >
              Save as new version
            </Button>
            <Button onClick={() => setPasteMode(false)}>Cancel</Button>
          </div>
        </div>
      )}
      <p className="mt-2 text-xs text-amber-700">
        {model
          ? `⚠ Parsing sends the resume text to ${provider} (${model.display_name}). Change this in Settings → Task routing → Resume parse.`
          : '⚠ No model is set for Resume parse (Settings → Task routing).'}
      </p>
      <div className="mt-2">
        <ErrorBox error={action.error} />
      </div>
    </Card>
  );
}

export default function ResumeTab({ profile, onProfileChange }: { profile: ProfileDetail; onProfileChange: (p: ProfileDetail) => void }) {
  const [viewId, setViewId] = useState<number | null>(null);
  const shownId = viewId && profile.resumes.some((r) => r.id === viewId) ? viewId : profile.activeResumeId;
  const resume = useIpc('resumes:get', { id: shownId ?? 0 }, [shownId]);
  const action = useAction();
  const [showText, setShowText] = useState(false);
  const confirm = useConfirm();

  const refreshProfile = async () => onProfileChange(await invoke('profiles:get', { id: profile.id }));

  useIpcEvent('resume:updated', (e) => {
    if (e.profileId !== profile.id) return;
    void refreshProfile();
    if (e.resumeId === shownId) void resume.reload();
  });

  const r = shownId ? resume.data : null;

  return (
    <div className="flex flex-col gap-4">
      <UploadCard
        profile={profile}
        onUploaded={(res) => {
          setViewId(res.id);
          void refreshProfile();
        }}
      />

      {profile.resumes.length > 0 && (
        <Card title="Versions">
          <table className="w-full text-sm">
            <tbody>
              {profile.resumes.map((v) => (
                <tr key={v.id} className={cx('border-b border-slate-100 last:border-0', v.id === shownId && 'bg-indigo-50/60')}>
                  <td className="w-14 py-1.5 font-medium">v{v.version}</td>
                  <td className="py-1.5">
                    <button type="button" className="text-left text-indigo-700 hover:underline" onClick={() => setViewId(v.id)}>
                      {v.fileName}
                    </button>
                  </td>
                  <td className="w-44 py-1.5 text-xs text-slate-500">{new Date(v.createdAt).toLocaleString()}</td>
                  <td className="w-44 py-1.5">
                    <div className="flex gap-1">
                      {v.isActive && <Badge tone="indigo">active</Badge>}
                      <Badge tone={STATUS[v.parseStatus].tone}>{STATUS[v.parseStatus].label}</Badge>
                      {v.edited && <Badge tone="amber">edited</Badge>}
                    </div>
                  </td>
                  <td className="w-64 py-1.5 text-right">
                    {!v.isActive && (
                      <Button size="sm" variant="ghost" onClick={() => action.run(async () => onProfileChange(await invoke('resumes:setActive', { id: v.id })))}>
                        Make active
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => action.run(() => invoke('resumes:openFile', { id: v.id }))}>
                      Open file
                    </Button>
                    <Button
                      size="sm"
                      variant="dangerGhost"
                      onClick={async () => {
                        if (await confirm({ title: `Delete resume v${v.version}?`, message: v.fileName, confirmLabel: 'Delete', danger: true })) void action.run(async () => onProfileChange(await invoke('resumes:delete', { id: v.id })));
                      }}
                    >
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-slate-500">The active version is the one used for matching. Every upload creates a new version and makes it active.</p>
          <div className="mt-2">
            <ErrorBox error={action.error} />
          </div>
        </Card>
      )}

      {r && (
        <>
          <Card
            title={
              <span className="flex items-center gap-2">
                Resume v{r.version}
                {r.isActive && <Badge tone="indigo">active</Badge>}
              </span>
            }
            actions={
              <>
                <Button size="sm" onClick={() => setShowText((s) => !s)}>
                  {showText ? 'Hide extracted text' : 'Show extracted text'}
                </Button>
                <Button
                  size="sm"
                  disabled={r.parseStatus === 'parsing' || action.busy}
                  onClick={async () => {
                    if (r.edited && !(await confirm({ title: 'Re-parse this resume?', message: 'Re-parsing replaces your manual corrections for this version.', confirmLabel: 'Re-parse' }))) return;
                    void action.run(async () => {
                      resume.set(await invoke('resumes:reparse', { id: r.id }));
                      void refreshProfile();
                    });
                  }}
                >
                  {r.parseStatus === 'pending' ? 'Parse' : 'Re-parse'}
                </Button>
              </>
            }
          >
            {r.parseStatus === 'parsing' && (
              <div className="flex items-center gap-2 text-sm text-slate-600">
                <Spinner /> Parsing the resume with the Resume parse model… this usually takes 10–60 seconds.
              </div>
            )}
            {r.parseStatus === 'failed' && <ErrorBox error={`Parsing failed: ${r.parseError}`} />}
            {r.parseStatus === 'pending' && <p className="text-sm text-slate-500">Not parsed yet.</p>}
            {r.parseStatus === 'done' && (
              <p className="text-sm text-slate-600">
                Parsed by <span className="font-medium">{r.modelName}</span>
                {r.promptVersion != null && <> with prompt v{r.promptVersion}</>}
                {r.parsedAt && <> · {new Date(r.parsedAt).toLocaleString()}</>}. Correct anything the model got wrong below — your edits are used for matching.
              </p>
            )}
            {showText && <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap rounded-md border border-slate-200 bg-slate-50 p-3 font-mono text-xs">{r.text}</pre>}
          </Card>

          {r.structured && (
            <StructuredEditor
              value={r.structured}
              edited={r.edited}
              busy={action.busy}
              onSave={(v) =>
                action.run(async () => {
                  resume.set(await invoke('resumes:saveStructured', { id: r.id, structured: v }));
                  void refreshProfile();
                })
              }
              onRevert={() =>
                action.run(async () => {
                  resume.set(await invoke('resumes:revertStructured', { id: r.id }));
                  void refreshProfile();
                })
              }
            />
          )}
        </>
      )}
      <ErrorBox error={resume.error && shownId ? resume.error : null} />
    </div>
  );
}
