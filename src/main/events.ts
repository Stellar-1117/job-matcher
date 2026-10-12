import { EventEmitter } from 'node:events';
import type { IpcEventName, IpcEvents } from '@shared/ipc';

/** In-process event bus; main/index.ts forwards these to renderer windows. */
class AppEvents extends EventEmitter {
  override emit<E extends IpcEventName>(event: E, payload: IpcEvents[E]): boolean {
    return super.emit(event, payload);
  }
}

export const appEvents = new AppEvents();
