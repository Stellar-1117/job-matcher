import { useState } from 'react';
import { WTTJ_BOOKMARKLET, type WttjMatch } from '@shared/wttj';
import { invoke, useIpc, useIpcEvent } from '../../api';
import { Badge, Button, Card, ErrorBox, Input, Spinner, Textarea, useAction } from '../../components/ui';
import { VERDICT_TONES } from '../../components/format';
import type { Navigate } from '../../App';

function MatchRow({ m }: { m: WttjMatch }) {
  return (
    <div className="flex items-start gap-3 border-b border-slate-100 px-3 py-1.5 last:border-0">
      <div className="w-28 shrink-0 pt-0.5">
        {m.status === 'new' ? <Badge tone="green">New</Badge> : <Badge>Already saved</Badge>}
      </div>
      <div className="min-w-0 flex-1">
        <a href={m.url} target="_blank" rel="noreferrer" className="block truncate text-sm font-medium text-indigo-700 hover:underline" title={m.url}>
          {m.title ?? m.url.replace(/^https:\/\//, '')}
        </a>
        <div className="flex flex-wrap items-center gap-1 text-xs text-slate-500">
          {m.companyName && <span className="mr-1">{m.companyName}</span>}
          {m.jobId == null && <span className="text-amber-700">deleted from the app since</span>}
          {m.analyses.map((a) => (
            <Badge key={a.profileId} tone={a.verdict ? VERDICT_TONES[a.verdict] : 'slate'}>
              {a.profileName} {a.status === 'scored' ? a.score : a.status}
            </Badge>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Import the jobs from the user's Welcome to the Jungle "Matches" page (needs a one-time sign-in). */
export default function WttjCard({ navigate }: { navigate: Navigate }) {
  const state = useIpc('wttj:state', {});
  useIpcEvent('jobs:updated', () => void state.reload());
  const [showAll, setShowAll] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [pasted, setPasted] = useState('');
  const [copied, setCopied] = useState(false);
  const action = useAction();

  const last = state.data?.lastImport ?? null;
  const fresh = last?.matches.filter((m) => m.status === 'new').length ?? 0;
  const shown = last ? (showAll ? last.matches : last.matches.filter((m) => m.status === 'new')) : [];

  const signIn = () =>
    action.run(async () => {
      setNote(null);
      const r = await invoke('wttj:signIn', {});
      setNote(r.signedIn ? 'Signed in. You can import your matches now.' : 'Sign-in window closed. If you signed in, try Import.');
    });
  const importNow = () =>
    action.run(async () => {
      setNote(null);
      await invoke('wttj:import', {});
      setShowAll(false);
      await state.reload();
    });
  const importPasted = () =>
    action.run(async () => {
      setNote(null);
      await invoke('wttj:importLinks', { text: pasted });
      setPasted('');
      setShowAll(false);
      await state.reload();
    });
  const copyBookmarklet = async () => {
    try {
      await navigator.clipboard.writeText(WTTJ_BOOKMARKLET);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  const signOut = () =>
    action.run(async () => {
      await invoke('wttj:signOut', {});
      setNote('Signed out of Welcome to the Jungle.');
    });

  return (
    <Card
      title="Welcome to the Jungle matches"
      actions={
        <>
          <Button size="sm" onClick={signIn} disabled={action.busy}>
            Sign in…
          </Button>
          <Button size="sm" variant="ghost" onClick={signOut} disabled={action.busy}>
            Sign out
          </Button>
          <Button size="sm" variant="primary" onClick={importNow} disabled={action.busy}>
            {action.busy ? 'Working…' : 'Import my matches'}
          </Button>
        </>
      }
    >
      <p className="text-xs text-slate-500">
        Saves every job on your{' '}
        <a href="https://www.welcometothejungle.com/en/jobs-matches" target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">
          Matches page
        </a>{' '}
        as a job link. Jobs the app already has are skipped and marked "Already saved". Sign in once; the app keeps that sign-in separate from everything else.
      </p>
      <details className="mt-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
        <summary className="cursor-pointer font-medium text-slate-700">Use Google to sign in to Welcome to the Jungle? Import from your browser instead</summary>
        <p className="mt-2 text-xs text-slate-600">
          Google doesn't allow signing in inside apps ("This browser or app may not be secure"). Signing in with your email and password works in the app; otherwise use your own browser, where you're already signed in:
        </p>
        <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-xs text-slate-700">
          <li>
            Copy this bookmarklet:{' '}
            <Button size="sm" onClick={() => void copyBookmarklet()}>
              {copied ? 'Copied ✓' : 'Copy bookmarklet'}
            </Button>
            <Input readOnly value={WTTJ_BOOKMARKLET} onFocus={(e) => e.currentTarget.select()} className="mt-1 w-full font-mono text-[10px]" />
          </li>
          <li>In Chrome, right-click the bookmarks bar → <b>Add page…</b>, name it "Copy WTTJ matches" and paste it as the URL. (Once.)</li>
          <li>
            Open your{' '}
            <a href="https://www.welcometothejungle.com/en/jobs-matches" target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">
              Matches page
            </a>{' '}
            in Chrome and click the bookmark. It scrolls through your matches and copies every job link.
          </li>
          <li>Paste here and import:</li>
        </ol>
        <Textarea rows={3} value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="Paste the copied job links" className="mt-2 font-mono text-xs" />
        <Button size="sm" variant="primary" className="mt-2" disabled={action.busy || !pasted.trim()} onClick={importPasted}>
          Import pasted links
        </Button>
      </details>
      {action.busy && (
        <p className="mt-2 flex items-center gap-2 text-sm text-slate-600">
          <Spinner /> Reading your matches (scrolling through the whole list)…
        </p>
      )}
      <div className="mt-2">
        <ErrorBox error={action.error ?? state.error} />
        {note && <p className="text-sm text-slate-600">{note}</p>}
      </div>
      {last && (
        <div className="mt-3">
          <div className="mb-1.5 flex flex-wrap items-center gap-3 text-sm">
            <span className="text-slate-600">Last import {new Date(last.importedAt).toLocaleString()}:</span>
            <span className="font-medium text-emerald-700">{fresh} new</span>
            <span className="text-slate-600">{last.matches.length - fresh} already saved</span>
            <button type="button" className="text-xs text-indigo-600 hover:underline" onClick={() => setShowAll((v) => !v)}>
              {showAll ? 'Show new only' : `Show all ${last.matches.length}`}
            </button>
            {fresh > 0 && (
              <button type="button" className="text-xs text-indigo-600 hover:underline" onClick={() => navigate('jobs')}>
                Analyze them on Jobs & Analyze →
              </button>
            )}
          </div>
          {shown.length > 0 ? (
            <div className="max-h-80 overflow-auto rounded-md border border-slate-200">
              {shown.map((m) => (
                <MatchRow key={m.url} m={m} />
              ))}
            </div>
          ) : (
            <p className="text-sm text-slate-500">No new jobs in the last import.</p>
          )}
        </div>
      )}
    </Card>
  );
}
