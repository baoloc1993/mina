// Intent của Đọc báo. Shell đã kiểm schema (ajv); ở đây kiểm lại tối thiểu vì dữ liệu đến từ app khác.
import { UUID_RE } from '../sdk';
import type { ItemRow } from '../data/repo';

export const NEWS_APP = 'vn.app.news';

export type ParsedIntent = { kind: 'news.open'; itemId: string } | { kind: 'unknown' };

export function parseIntent(type: string, payload: unknown): ParsedIntent {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  if (type === 'news.open') return typeof p.itemId === 'string' && UUID_RE.test(p.itemId) ? { kind: 'news.open', itemId: p.itemId } : { kind: 'unknown' };
  return { kind: 'unknown' };
}

/** `note.create@1` — `id` do Đọc báo sinh (gửi lại cùng id không tạo note trùng); thân = tóm tắt, `url` = liên kết bài. */
export function noteCreatePayload(item: Pick<ItemRow, 'title' | 'summary' | 'link'>, id: string) {
  const body = item.summary.trim();
  return { id, title: item.title.slice(0, 200), ...(body ? { body: body.slice(0, 20_000) } : {}), url: item.link };
}

/** `calendar.reminder.create@1` — `ref` trỏ thẳng tới bài (không qua Ghi chú). */
export function reminderPayload(item: Pick<ItemRow, 'id' | 'title'>, id: string, at: string) {
  return { id, title: item.title.slice(0, 200), at, ref: { app: NEWS_APP, id: item.id } };
}
