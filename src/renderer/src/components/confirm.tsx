import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from './ui';

/**
 * In-app confirmation dialog. Used instead of window.confirm(), which in Electron on Windows can
 * leave text inputs unable to take focus after the native dialog closes.
 */

export interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
}

type ConfirmFn = (o: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn>(async () => false);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ opts: ConfirmOptions; resolve: (v: boolean) => void } | null>(null);
  const confirmBtn = useRef<HTMLButtonElement>(null);

  const confirm = useCallback<ConfirmFn>((opts) => new Promise<boolean>((resolve) => setState({ opts, resolve })), []);

  const close = (v: boolean) => {
    state?.resolve(v);
    setState(null);
  };

  useEffect(() => {
    if (!state) return;
    confirmBtn.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {state && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40" onMouseDown={() => close(false)}>
          <div role="dialog" aria-modal="true" className="w-[28rem] max-w-[90vw] rounded-lg bg-white p-5 shadow-xl" onMouseDown={(e) => e.stopPropagation()}>
            <h2 className="text-base font-semibold text-slate-900">{state.opts.title}</h2>
            {state.opts.message && <div className="mt-2 text-sm text-slate-600">{state.opts.message}</div>}
            <div className="mt-5 flex justify-end gap-2">
              <Button onClick={() => close(false)}>Cancel</Button>
              <Button
                ref={confirmBtn}
                variant={state.opts.danger ? 'dangerSolid' : 'primary'}
                onClick={() => close(true)}
              >
                {state.opts.confirmLabel ?? 'OK'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  return useContext(ConfirmContext);
}
