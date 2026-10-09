// Truy cập dữ liệu Ghi chú qua `window.miniapp` (SDK 0.1.1). Bảng viết tên ngắn (notes, note_blocks, note_tags, note_files); bridge đổi
// tiền tố, tự lọc dòng đã xoá mềm và viết DELETE thành xoá mềm. Thuần logic — không đụng DOM nên test được trên mock SDK.
import * as Y from 'yjs';
import { b64encode, docFromPlain, extractText } from '../crdt/doc';
import { loadText } from '../crdt/session';
import { likePattern, makeSnippet, normalize, searchTerms } from '../search/normalize';
import { errCode, newId, type Sdk } from '../sdk';

export const TRASH_DAYS = 30;
export const DAY_MS = 86_400_000;
export const LIST_LIMIT = 500;

export interface NoteRow {
  id: string;
  title: string;
  pinned: number;
  trashed_at_ms: number | null;
  snippet: string;
  search_text: string;
  created_at: string;
  updated_at: string;
}

const COLS = 'id, title, pinned, trashed_at_ms, snippet, search_text, created_at, updated_at';

/** Danh sách chính (không gồm thùng rác): ghim trước, rồi theo lần sửa gần nhất. `terms` đã chuẩn hoá (AND), rỗng = tất cả. */
export async function listNotes(sdk: Sdk, terms: string[] = []): Promise<NoteRow[]> {
  const where = ['trashed_at_ms IS NULL', ...terms.map(() => "search_text LIKE ? ESCAPE '\\'")];
  return (await sdk.db.query<NoteRow>(
    `SELECT ${COLS} FROM notes WHERE ${where.join(' AND ')} ORDER BY pinned DESC, updated_at DESC LIMIT ${LIST_LIMIT}`,
    terms.map(likePattern),
  )) as NoteRow[];
}

export async function listTrash(sdk: Sdk): Promise<NoteRow[]> {
  return (await sdk.db.query<NoteRow>(`SELECT ${COLS} FROM notes WHERE trashed_at_ms IS NOT NULL ORDER BY trashed_at_ms DESC LIMIT ${LIST_LIMIT}`, [])) as NoteRow[];
}

export async function getNote(sdk: Sdk, id: string): Promise<NoteRow | null> {
  const rows = (await sdk.db.query<NoteRow>(`SELECT ${COLS} FROM notes WHERE id = ?`, [id])) as NoteRow[];
  return rows[0] ?? null;
}

/** Tạo note rỗng. `id` do bên gọi sinh (UUID client). */
export async function createNote(sdk: Sdk, id = newId(), title = ''): Promise<string> {
  await sdk.db.execute('INSERT INTO notes (id, title, pinned, trashed_at_ms, search_text, snippet) VALUES (?, ?, 0, NULL, ?, ?)', [id, title, normalize(title), '']);
  return id;
}

/** Lưu tiêu đề + dựng lại `search_text` (gồm nội dung hiện có) — LWW theo trường ở server. */
export async function setTitle(sdk: Sdk, id: string, title: string, text: string): Promise<void> {
  await sdk.db.execute('UPDATE notes SET title = ?, search_text = ? WHERE id = ?', [title, normalize(`${title} ${text}`), id]);
}

export async function setPinned(sdk: Sdk, id: string, pinned: boolean): Promise<void> {
  await sdk.db.execute('UPDATE notes SET pinned = ? WHERE id = ?', [pinned ? 1 : 0, id]);
}

export async function trashNote(sdk: Sdk, id: string, now = Date.now()): Promise<void> {
  await sdk.db.execute('UPDATE notes SET trashed_at_ms = ? WHERE id = ?', [now, id]);
}

export async function restoreNote(sdk: Sdk, id: string): Promise<void> {
  await sdk.db.execute('UPDATE notes SET trashed_at_ms = NULL WHERE id = ?', [id]);
}

/** Số ngày còn lại trước khi tự xoá hẳn (≥ 0). */
export function daysLeft(trashedAtMs: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((trashedAtMs + TRASH_DAYS * DAY_MS - now) / DAY_MS));
}

/**
 * Lớp dọn thứ nhất (khi mở app): xoá hẳn (xoá mềm) note quá 30 ngày thùng rác. Bỏ qua mốc trước lúc tạo note
 * (đồng hồ máy sai khi bấm xoá) — lớp server dùng giờ server nên là lớp quyết định. Trả số note đã dọn.
 */
export async function purgeExpired(sdk: Sdk, now = Date.now()): Promise<number> {
  const rows = (await sdk.db.query<NoteRow>(`SELECT ${COLS} FROM notes WHERE trashed_at_ms IS NOT NULL AND trashed_at_ms < ?`, [now - TRASH_DAYS * DAY_MS])) as NoteRow[];
  let n = 0;
  for (const r of rows) {
    const created = Date.parse(r.created_at);
    if (Number.isFinite(created) && Number(r.trashed_at_ms) < created) continue; // mốc xoá trước lúc tạo ⇒ đồng hồ sai
    await sdk.db.transaction([
      { sql: 'DELETE FROM notes WHERE id = ?', params: [r.id] },
      { sql: 'DELETE FROM note_blocks WHERE note_id = ?', params: [r.id] },
      { sql: 'DELETE FROM note_tags WHERE note_id = ?', params: [r.id] },
      { sql: 'DELETE FROM note_files WHERE note_id = ?', params: [r.id] },
    ]);
    n++;
  }
  return n;
}

/** Intent `note.create`: tạo note đúng `id` bên gửi (không tạo trùng); nội dung từ `body` + `url`. */
export async function createFromIntent(sdk: Sdk, p: { id?: string; title: string; body?: string; url?: string }): Promise<{ id: string; created: boolean }> {
  const id = p.id ?? newId();
  const dup = (await sdk.db.query<{ id: string }>('SELECT id FROM notes WHERE id = ?', [id], { includeDeleted: true })) as { id: string }[];
  if (dup.length) return { id, created: false };
  const doc = docFromPlain(p.body ?? '', p.url ?? null);
  const text = extractText(doc);
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  await sdk.db.transaction([
    { sql: 'INSERT INTO notes (id, title, pinned, trashed_at_ms, search_text, snippet) VALUES (?, ?, 0, NULL, ?, ?)', params: [id, p.title, normalize(`${p.title} ${text}`), makeSnippet(text)] },
    { sql: 'INSERT INTO note_blocks (id, note_id, kind, data, size) VALUES (?, ?, ?, ?, ?)', params: [newId(), id, 'update', b64encode(update), update.length] },
  ]);
  return { id, created: true };
}

/**
 * Dựng lại `search_text` + `snippet` từ Yjs cho tối đa `max` note còn trống cột tìm kiếm hoặc có `candidates` lệch sau hợp nhất.
 * Chỉ ghi khi giá trị tính ra KHÁC giá trị đang lưu — hai máy cùng hội tụ nên vòng lặp tự dừng. Trả số note đã sửa.
 */
export async function reindex(sdk: Sdk, candidates: string[] = [], max = 5): Promise<number> {
  const empty = (await sdk.db.query<{ id: string }>(`SELECT id FROM notes WHERE search_text = '' AND trashed_at_ms IS NULL LIMIT ${max}`, [])) as { id: string }[];
  const ids = [...new Set([...candidates, ...empty.map((r) => r.id)])].slice(0, max);
  let fixed = 0;
  for (const id of ids) {
    const note = await getNote(sdk, id);
    if (!note) continue;
    const text = await loadText(sdk, id);
    if (!text && !note.title) continue; // note rỗng thật sự
    const st = normalize(`${note.title} ${text}`);
    const sn = makeSnippet(text);
    if (st === note.search_text && sn === note.snippet) continue;
    await sdk.db.execute('UPDATE notes SET search_text = ?, snippet = ? WHERE id = ?', [st, sn, id]);
    fixed++;
  }
  return fixed;
}

/** Chữ ký các dòng `note_blocks` của từng note (đếm + mốc sửa) — đổi chữ ký mà không phải do mình ghi ⇒ có thay đổi từ máy khác. */
export async function blockSignatures(sdk: Sdk): Promise<Map<string, string>> {
  const rows = (await sdk.db.query<{ note_id: string; n: number; m: string }>('SELECT note_id, COUNT(*) AS n, MAX(updated_at) AS m FROM note_blocks GROUP BY note_id', [])) as { note_id: string; n: number; m: string }[];
  return new Map(rows.map((r) => [r.note_id, `${r.n}:${r.m}`]));
}

export { errCode };
