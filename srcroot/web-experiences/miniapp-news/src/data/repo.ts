// Truy cập dữ liệu Đọc báo qua `window.miniapp` (SDK 0.1.2). Bảng viết tên ngắn (sources, items); bridge đổi tiền tố, tự lọc dòng đã xoá
// mềm, viết DELETE thành xoá mềm và ghi đè cột hệ thống. Thuần logic — không đụng DOM nên test được trên mock SDK.
import { ID_GENERATIONS, itemId } from '../feed/id';
import type { ParsedItem } from '../feed/parse';
import type { Sdk } from '../sdk';

export const MAX_SOURCES = 30;
export const CACHE_DAYS = 30;
const DAY = 86_400_000;
const LIST_LIMIT = 300;
const BATCH = 99; // db.transaction ≤ 100 câu

export interface SourceRow {
  id: string;
  name: string;
  feed_url: string;
  host: string;
  position: number;
  suggested_key: string | null;
  last_fetched_at_ms: number | null;
  last_error: string | null;
}

export interface ItemRow {
  id: string;
  source_id: string;
  guid: string;
  title: string;
  summary: string;
  link: string;
  image_url: string | null;
  published_at_ms: number | null;
  fetched_at_ms: number;
  read_at_ms: number | null;
  saved_at_ms: number | null;
  note_id: string | null;
}

const SRC_COLS = 'id, name, feed_url, host, position, suggested_key, last_fetched_at_ms, last_error';
const ITEM_COLS = 'id, source_id, guid, title, summary, link, image_url, published_at_ms, fetched_at_ms, read_at_ms, saved_at_ms, note_id';

export interface SourceGroup {
  /** Dòng đại diện (id nhỏ nhất của các dòng cùng `feed_url`). */
  main: SourceRow;
  /** Mọi id thuộc nhóm (kể cả `main`) — hai máy cùng thêm một feed offline sinh hai dòng. */
  ids: string[];
}

/** Gộp nguồn trùng `feed_url` (hai máy cùng thêm offline): hiển thị một dòng, id nhỏ nhất thắng (cùng quy ước tag vòng 4). */
export function groupSources(rows: SourceRow[]): SourceGroup[] {
  const by = new Map<string, SourceRow[]>();
  for (const r of rows) by.set(r.feed_url, [...(by.get(r.feed_url) ?? []), r]);
  const out: SourceGroup[] = [];
  for (const list of by.values()) {
    const sorted = [...list].sort((a, b) => a.id.localeCompare(b.id));
    out.push({ main: sorted[0], ids: sorted.map((s) => s.id) });
  }
  return out.sort((a, b) => a.main.position - b.main.position || a.main.id.localeCompare(b.main.id));
}

export async function listSources(sdk: Sdk): Promise<SourceRow[]> {
  return (await sdk.db.query<SourceRow>(`SELECT ${SRC_COLS} FROM sources ORDER BY position, id`, [])) as SourceRow[];
}

/** Tên nguồn kể cả nguồn đã bỏ (bài Đọc sau của nguồn đã bỏ vẫn hiện tên + "nguồn đã bỏ"). */
export async function listSourceNames(sdk: Sdk): Promise<Map<string, { name: string; host: string; deleted: boolean }>> {
  const rows = (await sdk.db.query<{ id: string; name: string; host: string; deleted_at: string | null }>('SELECT id, name, host, deleted_at FROM sources', [], { includeDeleted: true })) as { id: string; name: string; host: string; deleted_at: string | null }[];
  return new Map(rows.map((r) => [r.id, { name: r.name, host: r.host, deleted: !!r.deleted_at }]));
}

const ORDER = 'ORDER BY COALESCE(published_at_ms, fetched_at_ms) DESC, fetched_at_ms DESC, id';

/** Tin mới: mọi bài còn sống (nguồn nào cũng được — lọc nguồn ở UI), tối đa 300. */
export async function listItems(sdk: Sdk): Promise<ItemRow[]> {
  return (await sdk.db.query<ItemRow>(`SELECT ${ITEM_COLS} FROM items ${ORDER} LIMIT ${LIST_LIMIT}`, [])) as ItemRow[];
}

/** Đọc sau: bài đã lưu, mới lưu trước. Không giới hạn 300 — bài đọc sau không bao giờ bị dọn. */
export async function listSaved(sdk: Sdk): Promise<ItemRow[]> {
  return (await sdk.db.query<ItemRow>(`SELECT ${ITEM_COLS} FROM items WHERE saved_at_ms IS NOT NULL ORDER BY saved_at_ms DESC, id`, [])) as ItemRow[];
}

export async function getItem(sdk: Sdk, id: string): Promise<ItemRow | null> {
  const rows = (await sdk.db.query<ItemRow>(`SELECT ${ITEM_COLS} FROM items WHERE id = ?`, [id])) as ItemRow[];
  return rows[0] ?? null;
}

export async function insertSourceWithItems(sdk: Sdk, src: Omit<SourceRow, 'last_error'> & { last_error?: string | null }, items: ParsedItem[], now: number): Promise<{ added: number }> {
  const srcStmt = {
    sql: 'INSERT INTO sources (id, name, feed_url, host, position, suggested_key, last_fetched_at_ms, last_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    params: [src.id, src.name, src.feed_url, src.host, src.position, src.suggested_key, src.last_fetched_at_ms, src.last_error ?? null],
  };
  // Lô đầu mang theo nguồn: nguồn và ≤ 99 bài đầu cùng thành công hoặc cùng không.
  const inserts = await planInserts(sdk, src.id, src.feed_url, items, now);
  await sdk.db.transaction([srcStmt, ...inserts.slice(0, BATCH)]);
  for (let i = BATCH; i < inserts.length; i += BATCH) await sdk.db.transaction(inserts.slice(i, i + BATCH));
  return { added: inserts.length };
}

interface Stmt {
  sql: string;
  params: (string | number | null)[];
}

/** Câu INSERT cho bài chưa có (xét cả dòng đã xoá mềm bằng dãy id `gen`). */
async function planInserts(sdk: Sdk, sourceId: string, feedUrl: string, items: ParsedItem[], now: number): Promise<Stmt[]> {
  const res = await resolveIds(sdk, feedUrl, items);
  const out: Stmt[] = [];
  for (const r of res) {
    if (r.state !== 'new') continue;
    const it = r.item;
    out.push({
      sql: 'INSERT INTO items (id, source_id, guid, title, summary, link, image_url, published_at_ms, fetched_at_ms, read_at_ms, saved_at_ms, note_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      params: [r.id, sourceId, it.guid, it.title, it.summary, it.link, it.image_url, it.published_at_ms, now, null, null, null],
    });
  }
  return out;
}

interface Resolved {
  item: ParsedItem;
  id: string;
  state: 'new' | 'live' | 'blocked';
  existing?: Pick<ItemRow, 'id' | 'title' | 'summary' | 'fetched_at_ms' | 'source_id'>;
}

/**
 * Với mỗi bài của feed, quyết id dùng được: lần lượt `itemId(feed, guid, 0..2)`; dòng SỐNG ⇒ `live` (UPDATE nhẹ), dòng đã xoá mềm ⇒
 * thử id kế (một dòng đã xoá không hồi sinh được — DECISIONS vòng 6), chưa có ⇒ `new`. Cả ba id đã xoá ⇒ `blocked` (bỏ qua bài).
 */
export async function resolveIds(sdk: Sdk, feedUrl: string, items: ParsedItem[]): Promise<Resolved[]> {
  const cand = items.map((it) => Array.from({ length: ID_GENERATIONS }, (_, g) => itemId(feedUrl, it.guid, g)));
  const all = [...new Set(cand.flat())];
  const found = new Map<string, { id: string; title: string; summary: string; fetched_at_ms: number; source_id: string; deleted_at: string | null }>();
  for (let i = 0; i < all.length; i += 90) {
    const part = all.slice(i, i + 90);
    const rows = (await sdk.db.query<{ id: string; title: string; summary: string; fetched_at_ms: number; source_id: string; deleted_at: string | null }>(
      `SELECT id, title, summary, fetched_at_ms, source_id, deleted_at FROM items WHERE id IN (${part.map(() => '?').join(', ')})`,
      part,
      { includeDeleted: true },
    )) as { id: string; title: string; summary: string; fetched_at_ms: number; source_id: string; deleted_at: string | null }[];
    for (const r of rows) found.set(r.id, r);
  }
  const claimed = new Set<string>();
  return items.map((it, i) => {
    for (const id of cand[i]) {
      const row = found.get(id);
      if (row && !row.deleted_at) return { item: it, id, state: 'live' as const, existing: row };
      if (!row && !claimed.has(id)) {
        claimed.add(id);
        return { item: it, id, state: 'new' as const };
      }
    }
    return { item: it, id: cand[i][0], state: 'blocked' as const };
  });
}

/**
 * Làm mới một nguồn: bài mới → INSERT; bài đã có → chỉ UPDATE khi tiêu đề/tóm tắt đổi HOẶC `fetched_at_ms` cũ hơn 1 ngày
 * (đủ cho mốc dọn 30 ngày, không đẩy hàng trăm PATCH mỗi lần bấm Làm mới). Luôn ghi `last_fetched_at_ms` / xoá `last_error`.
 */
export async function upsertItems(sdk: Sdk, source: SourceRow, items: ParsedItem[], now: number): Promise<{ added: number; touched: number }> {
  const res = await resolveIds(sdk, source.feed_url, items);
  const stmts: Stmt[] = [];
  let added = 0;
  let touched = 0;
  for (const r of res) {
    if (r.state === 'new') {
      added++;
      stmts.push({
        sql: 'INSERT INTO items (id, source_id, guid, title, summary, link, image_url, published_at_ms, fetched_at_ms, read_at_ms, saved_at_ms, note_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        params: [r.id, source.id, r.item.guid, r.item.title, r.item.summary, r.item.link, r.item.image_url, r.item.published_at_ms, now, null, null, null],
      });
    } else if (r.state === 'live' && r.existing) {
      const changed = r.existing.title !== r.item.title || r.existing.summary !== r.item.summary;
      if (changed || now - r.existing.fetched_at_ms >= DAY) {
        touched++;
        stmts.push(
          changed
            ? { sql: 'UPDATE items SET fetched_at_ms = ?, title = ?, summary = ? WHERE id = ?', params: [now, r.item.title, r.item.summary, r.id] }
            : { sql: 'UPDATE items SET fetched_at_ms = ? WHERE id = ?', params: [now, r.id] },
        );
      }
    }
  }
  for (let i = 0; i < stmts.length; i += BATCH) await sdk.db.transaction(stmts.slice(i, i + BATCH));
  await markFetched(sdk, source.id, now);
  return { added, touched };
}

export async function markFetched(sdk: Sdk, sourceId: string, now: number): Promise<void> {
  await sdk.db.execute('UPDATE sources SET last_fetched_at_ms = ?, last_error = ? WHERE id = ?', [now, null, sourceId]);
}

export async function markSourceError(sdk: Sdk, sourceId: string, error: string, current: string | null): Promise<void> {
  if (current === error) return; // không ghi lại cùng một lỗi (mỗi lần ghi là một PATCH đồng bộ)
  await sdk.db.execute('UPDATE sources SET last_error = ? WHERE id = ?', [error.slice(0, 300), sourceId]);
}

export async function renameSource(sdk: Sdk, ids: string[], name: string): Promise<void> {
  await sdk.db.transaction(ids.map((id) => ({ sql: 'UPDATE sources SET name = ? WHERE id = ?', params: [name.slice(0, 100), id] })));
}

/** Bỏ nguồn: xoá mềm nguồn (mọi bản trùng) + bài CHƯA đọc sau của nó; bài đọc sau giữ ("nguồn đã bỏ"). */
export async function removeSource(sdk: Sdk, ids: string[]): Promise<void> {
  await sdk.db.transaction(
    ids.flatMap((id) => [
      { sql: 'DELETE FROM items WHERE source_id = ? AND saved_at_ms IS NULL', params: [id] },
      { sql: 'DELETE FROM sources WHERE id = ?', params: [id] },
    ]),
  );
}

export async function markRead(sdk: Sdk, id: string, at: number): Promise<void> {
  await sdk.db.execute('UPDATE items SET read_at_ms = ? WHERE id = ? AND read_at_ms IS NULL', [at, id]);
}
export async function markUnread(sdk: Sdk, id: string): Promise<void> {
  await sdk.db.execute('UPDATE items SET read_at_ms = ? WHERE id = ?', [null, id]);
}
export async function setSaved(sdk: Sdk, id: string, at: number | null): Promise<void> {
  await sdk.db.execute('UPDATE items SET saved_at_ms = ? WHERE id = ?', [at, id]);
}
export async function setNoteId(sdk: Sdk, id: string, noteId: string): Promise<void> {
  await sdk.db.execute('UPDATE items SET note_id = ? WHERE id = ?', [noteId, id]);
}

/**
 * Dọn cache 30 ngày (AC-3): xoá mềm bài `saved_at_ms IS NULL` mà `fetched_at_ms` ∈ [created − 1 ngày, now − 30 ngày]. Mốc tương lai /
 * trước khi bài được tạo là đồng hồ máy sai → bỏ qua. Mỗi lần tối đa 100 bài (UPDATE không có LIMIT) — lần mở sau dọn tiếp.
 * Bài đọc sau (`saved_at_ms` có giá trị) KHÔNG BAO GIỜ bị dọn.
 */
export async function purgeOld(sdk: Sdk, now: number): Promise<number> {
  const cutoff = now - CACHE_DAYS * DAY;
  const rows = (await sdk.db.query<{ id: string }>('SELECT id FROM items WHERE saved_at_ms IS NULL AND fetched_at_ms < ? AND fetched_at_ms > ? LIMIT 100', [cutoff, 946_684_800_000])) as { id: string }[];
  if (!rows.length) return 0;
  await sdk.db.execute(`DELETE FROM items WHERE id IN (${rows.map(() => '?').join(', ')})`, rows.map((r) => r.id));
  return rows.length;
}
