// Singleton Runtime + hook cho UI.
import { useSyncExternalStore } from 'react';
import { RuntimeImpl } from './runtime';
import type { RuntimeState } from './types';

export const runtime = new RuntimeImpl();
export type { RuntimeState } from './types';
export * from './types';

export function useRuntime(): RuntimeState {
  return useSyncExternalStore(runtime.subscribe, runtime.getState, runtime.getState);
}
