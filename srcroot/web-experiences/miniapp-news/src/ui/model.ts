// Hàm thuần cho giao diện: gom bài theo ngày, tên nguồn, trạng thái nguồn, danh sách gợi ý từ cấu hình server.
import type { ItemRow, SourceGroup, SourceRow } from '../data/repo';
import { isFeedHost } from '../feed/url';
import { dayKey, dayLabel } from '../time';
import { unpackError } from '../sources/refresh';

export interface Suggestion {
  key: string;
  name: string;
  feed_url: string;
  host: string;
}

/** `sdk.info().config.sources` → danh sách gợi ý hợp lệ (mục hỏng bị bỏ, không ném). */
export function suggestionsOf(config: Record<string, unknown> | null | undefined): Suggestion[] {
  const raw = config?.sources;
  if (!Array.isArray(raw)) return [];
  const out: Suggestion[] = [];
  for (const s of raw) {
    const o = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
    if (typeof o.key !== 'string' || typeof o.name !== 'string' || typeof o.feed_url !== 'string' || typeof o.host !== 'string') continue;
    if (!o.name.trim() || !isFeedHost(o.host)) continue;
    out.push({ key: o.key.slice(0, 64), name: o.name.trim().slice(0, 100), feed_url: o.feed_url, host: o.host });
  }
  return out.slice(0, 50);
}

/** Gợi ý đã thêm? So theo feed_url (đã chuẩn hoá) hoặc khoá gợi ý của nguồn. */
export function isAdded(s: Suggestion, groups: SourceGroup[]): boolean {
  return groups.some((g) => g.main.suggested_key === s.key || g.main.feed_url === s.feed_url);
}

export interface DayGroup {
  key: string;
  label: string;
  items: ItemRow[];
}

/** Nhóm theo ngày (giữ thứ tự đầu vào — đã sắp mới nhất trước). Ngày lấy từ `published_at_ms` (thiếu → `fetched_at_ms`). */
export function groupByDay(items: ItemRow[], now: number): DayGroup[] {
  const out: DayGroup[] = [];
  for (const it of items) {
    const ms = it.published_at_ms ?? it.fetched_at_ms;
    const key = dayKey(ms);
    const last = out[out.length - 1];
    if (last && last.key === key) last.items.push(it);
    else out.push({ key, label: dayLabel(ms, now), items: [it] });
  }
  return out;
}

export interface SourceInfo {
  name: string;
  host: string;
  /** Nguồn đã bỏ (chỉ gặp ở Đọc sau). */
  removed: boolean;
}

/**
 * Tên nguồn của một bài. Hai máy cùng thêm một feed ⇒ `source_id` của bài có thể là id "bản trùng" — tra qua nhóm để hiện đúng tên.
 */
export function sourceOf(item: ItemRow, groups: SourceGroup[], names: Map<string, { name: string; host: string; deleted: boolean }>): SourceInfo {
  const g = groups.find((x) => x.ids.includes(item.source_id));
  if (g) return { name: g.main.name, host: g.main.host, removed: false };
  const n = names.get(item.source_id);
  return n ? { name: n.name, host: n.host, removed: true } : { name: 'Nguồn không rõ', host: '', removed: true };
}

export type SourceState = 'busy' | 'ok' | 'warn' | 'none';

export function sourceState(src: SourceRow, busy: boolean): SourceState {
  if (busy) return 'busy';
  if (src.last_error) return 'warn';
  return src.last_fetched_at_ms ? 'ok' : 'none';
}

/** Số nguồn đang lỗi (hiện ở banner S19). */
export function failingCount(groups: SourceGroup[]): number {
  return groups.filter((g) => !!g.main.last_error).length;
}

export const errorOf = (src: SourceRow) => unpackError(src.last_error);

/** Lần cập nhật gần nhất thành công của mọi nguồn (`last_fetched_at_ms` lớn nhất). */
export function lastUpdate(groups: SourceGroup[]): number | null {
  const v = groups.map((g) => g.main.last_fetched_at_ms ?? 0);
  const m = Math.max(0, ...v);
  return m > 0 ? m : null;
}

/** Lọc theo nguồn (id bất kỳ của nhóm). */
export function filterItems(items: ItemRow[], filter: string | null, groups: SourceGroup[]): ItemRow[] {
  if (!filter) return items;
  const ids = groups.find((g) => g.main.id === filter)?.ids ?? [filter];
  return items.filter((i) => ids.includes(i.source_id));
}
