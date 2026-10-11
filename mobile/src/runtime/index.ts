// Singleton Runtime + hook cho UI.
import { useSyncExternalStore } from 'react';
import { RuntimeImpl } from './runtime';
import type { RuntimeState } from './types';

export const runtime = new RuntimeImpl();
// Khởi động đúng một lần khi module được nạp (không phụ thuộc vào cây React).
void runtime.init();
export type { RuntimeState } from './types';
export * from './types';

export function useRuntime(): RuntimeState {
  return useSyncExternalStore(runtime.subscribe, runtime.getState, runtime.getState);
}
