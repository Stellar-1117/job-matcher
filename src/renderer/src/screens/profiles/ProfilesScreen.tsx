import { useEffect, useState } from 'react';
import type { ProfileDetail } from '@shared/profile';
import { invoke, useIpc, useIpcEvent } from '../../api';
import { Badge, Button, ErrorBox, Input, Tabs, cx, useAction } from '../../components/ui';
import ResumeTab from './ResumeTab';
import PreferencesTab from './PreferencesTab';
import { useConfirm } from '../../components/confirm';

type Tab = 'resume' | 'preferences';

const STATUS_BADGE: Record<string, { label: string; tone: 'slate' | 'blue' | 'green' | 'red' }> = {
  pending: { label: 'not parsed', tone: 'slate' },
  parsing: { label: 'parsing…', tone: 'blue' },
  done: { label: 'ready', tone: 'green' },
  failed: { label: 'parse failed', tone: 'red' },
};

function ProfileHeader({ profile, onChange, onDeleted }: { profile: ProfileDetail; onChange: (p: ProfileDetail) => void; onDeleted: () => void }) {
  const [editing, setEditing] = useState(false);
  const confirm = useConfirm();
  const [name, setName] = useState(profile.name);
  const action = useAction();
  useEffect(() => setName(profile.name), [profile.name]);

  return (
    <div className="flex items-center gap-3">
      {editing ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              onChange(await invoke('profiles:rename', { id: profile.id, name }));
              setEditing(false);
            });
          }}
        >
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} className="w-64" />
          <Button type="submit" variant="primary" size="sm" disabled={!name.trim()}>
            Save
          </Button>
          <Button size="sm" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </form>
      ) : (
        <>
          <h1 className="text-xl font-semibold">{profile.name}</h1>
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            Rename
          </Button>
        </>
      )}
      <Button
        size="sm"
        variant="dangerGhost"
        className="ml-auto"
        onClick={async () => {
          if (await confirm({ title: `Delete profile "${profile.name}"?`, message: 'All its resume versions and preferences are deleted. This cannot be undone.', confirmLabel: 'Delete', danger: true }))
            void action.run(async () => {
              await invoke('profiles:delete', { id: profile.id });
              onDeleted();
            });
        }}
      >
        Delete profile
      </Button>
      <ErrorBox error={action.error} />
    </div>
  );
}

export default function ProfilesScreen() {
  const profiles = useIpc('profiles:list', {});
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<ProfileDetail | null>(null);
  const [tab, setTab] = useState<Tab>('resume');
  const [newName, setNewName] = useState('');
  const action = useAction();

  const list = profiles.data ?? [];
  const currentId = selectedId ?? list[0]?.id ?? null;

  useEffect(() => {
    if (currentId == null) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    void invoke('profiles:get', { id: currentId })
      .then((p) => !cancelled && setDetail(p))
      .catch((e) => action.setError((e as Error).message));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId]);

  useIpcEvent('resume:updated', () => void profiles.reload());

  const onProfileChange = (p: ProfileDetail) => {
    setDetail(p);
    void profiles.reload();
  };

  return (
    <div className="flex h-full">
      <aside className="flex w-64 shrink-0 flex-col border-r border-slate-200 bg-white">
        <div className="border-b border-slate-100 p-3">
          <form
            className="flex gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (!newName.trim()) return;
              void action.run(async () => {
                const p = await invoke('profiles:create', { name: newName });
                setNewName('');
                setSelectedId(p.id);
                setTab('resume');
                await profiles.reload();
              });
            }}
          >
            <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New profile name" className="min-w-0 flex-1" />
            <Button type="submit" variant="primary" size="sm" disabled={!newName.trim() || action.busy}>
              Add
            </Button>
          </form>
        </div>
        <div className="flex-1 overflow-auto p-2">
          {list.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setSelectedId(p.id)}
              className={cx('mb-1 w-full rounded-md px-3 py-2 text-left', p.id === currentId ? 'bg-indigo-50' : 'hover:bg-slate-50')}
            >
              <div className="flex items-center gap-2">
                <span className={cx('truncate font-medium', p.id === currentId ? 'text-indigo-700' : 'text-slate-800')}>{p.name}</span>
                {p.activeParseStatus ? (
                  <Badge tone={STATUS_BADGE[p.activeParseStatus].tone}>{STATUS_BADGE[p.activeParseStatus].label}</Badge>
                ) : (
                  <Badge>no resume</Badge>
                )}
              </div>
              <div className="truncate text-xs text-slate-500">{p.headline ?? `${p.resumeCount} resume version${p.resumeCount === 1 ? '' : 's'}`}</div>
            </button>
          ))}
          {profiles.data && !list.length && <p className="p-3 text-sm text-slate-500">No profiles yet. Add one above — one per person you search jobs for.</p>}
        </div>
      </aside>

      <section className="min-w-0 flex-1 overflow-auto">
        <div className="p-6">
          <ErrorBox error={profiles.error ?? action.error} />
          {detail ? (
            <div className="flex flex-col gap-4">
              <ProfileHeader
                profile={detail}
                onChange={onProfileChange}
                onDeleted={() => {
                  setSelectedId(null);
                  setDetail(null);
                  void profiles.reload();
                }}
              />
              <Tabs
                tabs={[
                  { key: 'resume', label: 'Resume' },
                  { key: 'preferences', label: 'Preferences' },
                ]}
                value={tab}
                onChange={setTab}
              />
              {tab === 'resume' ? <ResumeTab profile={detail} onProfileChange={onProfileChange} /> : <PreferencesTab profile={detail} onProfileChange={onProfileChange} />}
            </div>
          ) : (
            profiles.data &&
            !list.length && (
              <div className="py-16 text-center text-slate-500">
                <h1 className="mb-2 text-xl font-semibold text-slate-700">Profiles</h1>
                A profile is a person: a resume (versioned) plus job preferences. Create one on the left to get started.
              </div>
            )
          )}
        </div>
      </section>
    </div>
  );
}
