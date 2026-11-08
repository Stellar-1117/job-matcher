import { useMemo, useRef, useState } from 'react';
import { FETCH_BLOCK_LABELS, PASS_WINDOWS_DEFAULT, PASS_WINDOWS_MAX, type HumanPassState } from '@shared/sites';
import { invoke, useIpc, useIpcEvent } from '../../api';
import { Badge, Button, Card, ErrorBox, Select, Spinner, useAction } from '../../components/ui';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const WINDOWS_KEY = 'humanPass.windows';

/** How many windows the human pass opens (remembered on this computer). */
export function passWindows(): number {
  try {
    const n = Number(localStorage.getItem(WINDOWS_KEY));
    if (Number.isInteger(n) && n >= 1 && n <= PASS_WINDOWS_MAX) return n;
  } catch {
    // storage unavailable
  }
  return PASS_WINDOWS_DEFAULT;
}

/**
 * Links where the site asked for a person (bot check / CAPTCHA, or a sign-in). They wait here while
 * the analysis reads everything else; "Pass them now" opens them one by one in a visible window,
 * and the analysis carries on with them afterwards.
 */
export default function HumanPassCard({ disabled }: { disabled?: boolean }) {
  const queue = useIpc('sites:humanQueue', {});
  const pass = useIpc('sites:passState', {});
  const action = useAction();
  const [windows, setWindows] = useState(passWindows);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reloadSoon = () => {
    if (reloadTimer.current) return;
    reloadTimer.current = setTimeout(() => {
      reloadTimer.current = null;
      void queue.reload();
    }, 1000);
  };
  useIpcEvent('sites:pass', (s: HumanPassState) => {
    pass.set(s);
    if (!s.active) void queue.reload();
  });
  useIpcEvent('jobs:updated', reloadSoon);
  useIpcEvent('analyze:progress', (p) => {
    if (p.status !== 'running') void queue.reload();
  });

  const sites = useMemo(() => {
    const m = new Map<string, number>();
    for (const j of queue.data ?? []) m.set(j.host, (m.get(j.host) ?? 0) + 1);
    return [...m.entries()];
  }, [queue.data]);

  const s = pass.data;
  const active = !!s?.active;
  const waiting = queue.data?.length ?? 0;
  if (!active && !waiting && !(s && s.finished > 0)) return null;

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          {active && <Spinner />}
          {active ? 'Passing checks…' : `Needs you: ${plural(waiting, 'link')} behind a bot check or sign-in`}
        </span>
      }
      actions={
        active ? (
          <Button size="sm" variant="danger" onClick={() => void action.run(() => invoke('sites:passStop', {}))} title="Close the windows; the links left keep waiting here">
            Stop
          </Button>
        ) : (
          <>
            <Select
              aria-label="Windows side by side"
              title="How many windows to open side by side: work through them in turn while the others load"
              value={String(windows)}
              onChange={(e) => {
                const n = Number(e.target.value);
                setWindows(n);
                try {
                  localStorage.setItem(WINDOWS_KEY, String(n));
                } catch {
                  // storage unavailable
                }
              }}
            >
              {Array.from({ length: PASS_WINDOWS_MAX }, (_, i) => i + 1).map((n) => (
                <option key={n} value={String(n)}>
                  {plural(n, 'window')}
                </option>
              ))}
            </Select>
            <Button
              size="sm"
              variant="primary"
              disabled={!waiting || disabled || action.busy}
              title={disabled ? 'Wait for the analysis to finish reading the other links' : undefined}
              onClick={() => void action.run(async () => pass.set(await invoke('sites:passStart', { jobIds: null, windows })))}
            >
              Pass them now
            </Button>
          </>
        )
      }
    >
      {active && s ? (
        <div className="flex flex-col gap-1.5 text-sm">
          <div className="flex items-center gap-3">
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
              <div className="h-full rounded-full bg-indigo-600 transition-all" style={{ width: `${s.total ? Math.round((s.finished / s.total) * 100) : 0}%` }} />
            </div>
            <span className="w-20 text-right tabular-nums text-slate-700">
              {s.finished}/{s.total}
            </span>
          </div>
          <div className="flex flex-col divide-y divide-slate-100 rounded-md border border-slate-200">
            {s.slots.map((slot) => (
              <div key={slot.window} className="flex items-start gap-2 px-2 py-1.5">
                <span className="w-16 shrink-0 pt-0.5 text-xs font-medium text-slate-500">Window {slot.window}</span>
                <div className="min-w-0 flex-1">
                  {slot.current ? (
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="shrink-0">
                        <Badge tone="amber">{FETCH_BLOCK_LABELS[slot.current.block]}</Badge>
                      </span>
                      <span className="shrink-0 font-mono text-xs text-slate-500">{slot.current.host}</span>
                      <span className="min-w-0 truncate" title={slot.current.url}>
                        <span className="font-medium text-slate-800">{slot.current.title ?? slot.current.url.replace(/^https:\/\//, '')}</span>
                        {slot.current.companyName && <span className="text-slate-500"> · {slot.current.companyName}</span>}
                      </span>
                    </div>
                  ) : null}
                  <p className={slot.current ? 'text-xs text-amber-700' : 'text-xs text-slate-500'}>{slot.hint ?? (slot.current ? 'Loading the page…' : 'Opening…')}</p>
                </div>
                {slot.current && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void action.run(() => invoke('sites:passSkip', { jobId: slot.current!.jobId }))}
                    title="Leave this link for later (or paste it by hand) and open the next one in this window"
                  >
                    Skip
                  </Button>
                )}
              </div>
            ))}
          </div>
          <p className="text-xs text-slate-500">
            Work through the "Job Matcher — window …" windows in turn: tick the check box / solve the puzzle, or sign in (or create an account). Each posting is read as soon as it shows and
            that window opens the next link by itself. A site stays in one window until its check is passed, then its other links spread over all windows. Closing a window hands its
            link to the others. {s.read > 0 && `${plural(s.read, 'posting')} read so far.`}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2 text-sm">
          {waiting > 0 ? (
            <>
              <p className="text-slate-600">
                These sites asked for a person, so the links were set aside while the rest was read. Go through them together: each opens in a window where you pass the check or sign in
                once — the app remembers the session for next time — and the analysis then carries on with them.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {sites.map(([host, n]) => (
                  <Badge key={host}>
                    {host} · {n}
                  </Badge>
                ))}
              </div>
            </>
          ) : null}
          {s && s.finished > 0 && (
            <p className="text-xs text-emerald-700">
              ✓ Last pass: {plural(s.read, 'posting')} read{s.closed ? `, ${s.closed} closed` : ''}
              {s.skipped ? `, ${s.skipped} skipped` : ''}
              {s.resumedRunId != null ? ' — the analysis resumed with them.' : '.'}
            </p>
          )}
        </div>
      )}
      <ErrorBox error={queue.error ?? action.error} />
    </Card>
  );
}
