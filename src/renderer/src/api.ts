import { useCallback, useEffect, useRef, useState } from 'react';
import type { IpcChannel, IpcEventName, IpcEvents, IpcInput, IpcOutput } from '@shared/ipc';

export const api = window.api;

export function invoke<C extends IpcChannel>(channel: C, input: IpcInput<C>): Promise<IpcOutput<C>> {
  return api.invoke(channel, input);
}

/** Load data from an IPC channel; `set` lets mutations that return fresh data update it in place. */
export function useIpc<C extends IpcChannel>(channel: C, input: IpcInput<C>, deps: unknown[] = []) {
  const [data, setData] = useState<IpcOutput<C> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.invoke(channel, input));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, ...deps]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, error, loading, reload, set: setData };
}

/** Subscribe to a main-process push event for the lifetime of the component. */
export function useIpcEvent<E extends IpcEventName>(event: E, cb: (payload: IpcEvents[E]) => void) {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => api.on(event, (p) => ref.current(p)), [event]);
}
