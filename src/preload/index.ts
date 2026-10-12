import { contextBridge, ipcRenderer } from 'electron';
import type { IpcResult, JobMatcherApi } from '@shared/ipc';

const api: JobMatcherApi = {
  async invoke(channel, input) {
    const res = (await ipcRenderer.invoke(channel, input)) as IpcResult<any>;
    if (!res.ok) throw new Error(res.error);
    return res.data;
  },
  on(event, cb) {
    const listener = (_e: Electron.IpcRendererEvent, payload: any) => cb(payload);
    ipcRenderer.on(`event:${event}`, listener);
    return () => ipcRenderer.removeListener(`event:${event}`, listener);
  },
};

contextBridge.exposeInMainWorld('api', api);
