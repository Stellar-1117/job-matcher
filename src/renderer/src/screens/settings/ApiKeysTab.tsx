import { useState } from 'react';
import type { ApiKeyInfo } from '@shared/types';
import { invoke, useIpc } from '../../api';
import { Badge, Button, Card, ErrorBox, Field, Input, useAction } from '../../components/ui';
import { useConfirm } from '../../components/confirm';

function KeyRow({ info, onChange }: { info: ApiKeyInfo; onChange: (list: ApiKeyInfo[]) => void }) {
  const [key, setKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(info.baseUrl ?? '');
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const action = useAction();
  const baseUrlEditable = info.isCustom || info.provider === 'deepseek';
  const confirm = useConfirm();

  const save = () =>
    action.run(async () => {
      const list = await invoke('keys:set', {
        provider: info.provider,
        ...(key ? { key } : {}),
        ...(baseUrlEditable ? { baseUrl: baseUrl.trim() || null } : {}),
      });
      setKey('');
      setTest(null);
      onChange(list);
    });

  return (
    <div className="grid grid-cols-[160px_1fr] gap-4 border-b border-slate-100 py-4 last:border-0">
      <div>
        <div className="font-medium">{info.displayName}</div>
        <div className="mt-1">{info.masked ? <Badge tone="green">{info.masked}</Badge> : <Badge>No key</Badge>}</div>
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-end gap-2">
          <Field label={info.masked ? 'Replace key' : 'API key'}>
            <Input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Paste key" className="w-80" />
          </Field>
          {baseUrlEditable && (
            <Field label="Base URL">
              <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className="w-72" placeholder="https://…" />
            </Field>
          )}
          <Button variant="primary" disabled={action.busy || (!key && (!baseUrlEditable || baseUrl === (info.baseUrl ?? '')))} onClick={save}>
            Save
          </Button>
          <Button
            disabled={action.busy || !info.masked}
            onClick={() => action.run(async () => setTest(await invoke('keys:test', { provider: info.provider })))}
          >
            {action.busy ? 'Working…' : 'Test'}
          </Button>
          {(info.masked || info.isCustom) && (
            <Button
              variant="danger"
              disabled={action.busy}
              onClick={async () => {
                if (await confirm({ title: `Delete the ${info.displayName} key${info.isCustom ? ' and provider' : ''}?`, confirmLabel: 'Delete', danger: true }))
                  void action.run(async () => onChange(await invoke('keys:delete', { provider: info.provider })));
              }}
            >
              Delete
            </Button>
          )}
        </div>
        {test && (
          <div className={test.ok ? 'text-sm text-emerald-700' : 'text-sm text-red-600'}>
            {test.ok ? '✓ ' : '✗ '}
            {test.message}
          </div>
        )}
        <ErrorBox error={action.error} />
      </div>
    </div>
  );
}

function AddCustomProvider({ onChange }: { onChange: (list: ApiKeyInfo[]) => void }) {
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [key, setKey] = useState('');
  const action = useAction();
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

  return (
    <Card title="Add custom OpenAI-compatible provider">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. OpenRouter" className="w-48" />
        </Field>
        <Field label="Base URL">
          <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://…/v1" className="w-72" />
        </Field>
        <Field label="API key">
          <Input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} className="w-64" />
        </Field>
        <Button
          variant="primary"
          disabled={action.busy || !slug || !baseUrl || !key}
          onClick={() =>
            action.run(async () => {
              onChange(await invoke('keys:set', { provider: `custom:${slug}`, displayName: name.trim(), baseUrl: baseUrl.trim(), key }));
              setName('');
              setBaseUrl('');
              setKey('');
            })
          }
        >
          Add
        </Button>
      </div>
      {slug && <p className="mt-2 text-xs text-slate-500">Provider key: custom:{slug} — use it in the model registry.</p>}
      <div className="mt-2">
        <ErrorBox error={action.error} />
      </div>
    </Card>
  );
}

export default function ApiKeysTab() {
  const keys = useIpc('keys:list', {});
  return (
    <div className="flex max-w-5xl flex-col gap-4">
      <Card title="Provider API keys">
        <p className="mb-2 text-sm text-slate-500">
          Keys are encrypted with the operating system's secure storage and never leave the main process. Only the last four characters are shown here.
        </p>
        <ErrorBox error={keys.error} />
        {keys.data?.map((k) => <KeyRow key={k.provider + (k.masked ?? '')} info={k} onChange={keys.set} />)}
      </Card>
      <AddCustomProvider onChange={keys.set} />
    </div>
  );
}
