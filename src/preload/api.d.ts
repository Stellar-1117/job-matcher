import type { JobMatcherApi } from '../shared/ipc';

declare global {
  interface Window {
    api: JobMatcherApi;
  }
}

export {};
