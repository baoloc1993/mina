// Chọn file cache để dọn (LRU) — thuần TS, test được bằng Jest.
export interface EvictRow {
  id: string;
  status: 'local' | 'uploading' | 'uploaded' | 'cached';
  size: number;
  last_used_at: number;
}

export const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;

/** File cần dọn (cũ nhất trước) để tổng ≤ maxBytes. `local`/`uploading` không bao giờ bị chọn. */
export function pickEvictions(rows: EvictRow[], maxBytes: number): string[] {
  let total = rows.reduce((a, r) => a + r.size, 0);
  const out: string[] = [];
  const evictable = rows.filter((r) => r.status === 'uploaded' || r.status === 'cached').sort((a, b) => a.last_used_at - b.last_used_at);
  for (const r of evictable) {
    if (total <= maxBytes) break;
    out.push(r.id);
    total -= r.size;
  }
  return out;
}

