import { useState } from 'react';
import { SIGN_IN_SITES } from '@shared/sites';
import { invoke, useIpc } from '../../api';
import { Button, Card, ErrorBox, Input, useAction } from '../../components/ui';
import { useConfirm } from '../../components/confirm';

/** Sign in (or sign up) on job sites once; the app keeps the session for its page fetches. */
export default function SitesTab() {
  const sessions = useIpc('sites:sessions', {});
  const [url, setUrl] = useState('');
  const action = useAction();
  const confirm = useConfirm();

  const open = (target: string) => action.run(() => invoke('sites:openSignIn', { url: target }));
  const clear = async (domain: string | null) => {
    const ok = await confirm({
      title: domain ? `Sign out of ${domain}?` : 'Sign out of every site?',
      message: domain
        ? 'Its saved cookies are deleted. The next time a page there needs it, sign in or pass the check again.'
        : 'All saved site cookies are deleted (sign-ins and passed bot checks).',
      confirmLabel: 'Sign out',
      danger: true,
    });
    if (ok) void action.run(async () => sessions.set(await invoke('sites:clear', { domain })));
  };

  return (
    <div className="flex max-w-4xl flex-col gap-4">
      <Card title="Sign in to job sites">
        <p className="-mt-1 mb-3 text-sm text-slate-500">
          Some sites only show postings to signed-in people. Open the site's sign-in page here and sign in — or create an account if you don't have one yet (the sign-in page links
          to sign-up). Close the window when you're done: the app keeps the session and uses it for every later fetch on that site. You only need to do this again if the site
          signs you out.
        </p>
        <div className="flex flex-wrap gap-2">
          {SIGN_IN_SITES.map((s) => (
            <Button key={s.label} onClick={() => void open(s.url)} disabled={action.busy}>
              {s.label}
            </Button>
          ))}
        </div>
        <div className="mt-3 flex items-center gap-2">
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Another site: https://…" className="w-96" />
          <Button disabled={action.busy || !/^https?:\/\/\S+\.\S+/.test(url.trim())} onClick={() => void open(url.trim())}>
            Open
          </Button>
        </div>
        <p className="mt-3 text-xs text-slate-500">
          Bot checks (Cloudflare "Just a moment…", CAPTCHAs) are handled in Jobs → Analyze: pages that hit one are set aside under "Needs you" and you pass them together after
          the run.
        </p>
      </Card>

      <Card
        title="Saved site sessions"
        actions={
          <>
            <Button size="sm" variant="ghost" onClick={() => void sessions.reload()}>
              Refresh
            </Button>
            <Button size="sm" variant="danger" disabled={action.busy || !sessions.data?.length} onClick={() => void clear(null)}>
              Sign out everywhere
            </Button>
          </>
        }
      >
        <ErrorBox error={sessions.error ?? action.error} />
        {sessions.data && sessions.data.length === 0 && <p className="py-3 text-sm text-slate-500">No saved sessions yet.</p>}
        {sessions.data && sessions.data.length > 0 && (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="py-1.5 pr-3">Site</th>
                <th className="py-1.5 pr-3 text-right">Cookies</th>
                <th className="py-1.5 pr-3">Kept until</th>
                <th className="py-1.5" />
              </tr>
            </thead>
            <tbody>
              {sessions.data.map((s) => (
                <tr key={s.domain} className="border-b border-slate-100 last:border-0">
                  <td className="py-1.5 pr-3 font-mono">{s.domain}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{s.cookies}</td>
                  <td className="py-1.5 pr-3 text-slate-600">{s.expiresAt ? new Date(s.expiresAt).toLocaleDateString() : 'this session'}</td>
                  <td className="py-1.5 text-right">
                    <button type="button" className="text-xs text-red-600 hover:underline" onClick={() => void clear(s.domain)}>
                      Sign out
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
