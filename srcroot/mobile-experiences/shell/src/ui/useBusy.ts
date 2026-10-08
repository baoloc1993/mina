// Cờ "đang xử lý" cho một hành động bất đồng bộ: khoá bấm lại, không setState sau khi màn đã đóng.
import { useCallback, useEffect, useRef, useState } from 'react';

export function useBusy(): [boolean, <T>(fn: () => Promise<T>) => Promise<T | undefined>] {
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const running = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    if (running.current) return undefined;
    running.current = true;
    if (alive.current) setBusy(true);
    try {
      return await fn();
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
  }, []);
  return [busy, run];
}
