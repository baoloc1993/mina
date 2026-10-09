// Tag dùng chung (`core_tags`) + liên kết note↔tag (`note_tags`). Quy ước gộp theo tên ở PHÍA APP (DECISIONS vòng 4): tên đã trim + hạ
// chữ thường (KHÔNG bỏ dấu: "Việc" ≠ "Viec"); hai máy cùng tạo "việc nhà" lúc offline → hai dòng `core_tags` → hiển thị một.
import { errCode, newId, type Sdk } from '../sdk';

export interface TagRow {
  id: string;
  name: string;
  color?: string | null;
}

export interface TagGroup {
  /** Khoá gộp: tên đã trim + hạ chữ thường. */
  key: string;
  /** Tên hiển thị (của bản chuẩn). */
  name: string;
  /** Bản chuẩn — id nhỏ nhất (`core.tags.list` không trả `created_at`; id nhỏ nhất là quy ước tất định giữa các máy). */
  canonical: string;
  /** Mọi id thuộc nhóm (gồm bản trùng). */
  ids: string[];
}

export const tagKey = (name: string) => name.trim().toLowerCase();

export function groupTags(tags: TagRow[]): TagGroup[] {
  const by = new Map<string, TagRow[]>();
  for (const t of tags) {
    const k = tagKey(t.name);
    if (!k) continue;
    by.set(k, [...(by.get(k) ?? []), t]);
  }
  return [...by.entries()]
    .map(([key, list]) => {
      const sorted = [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return { key, name: sorted[0].name.trim(), canonical: sorted[0].id, ids: sorted.map((t) => t.id) };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'vi'));
}

export async function listTagGroups(sdk: Sdk): Promise<TagGroup[]> {
  return groupTags((await sdk.core.tags.list()) as TagRow[]);
}

/** Dùng lại tag cùng tên (không phân biệt hoa thường) nếu có, không thì tạo mới. `reused` báo đã có sẵn. */
export async function ensureTag(sdk: Sdk, name: string): Promise<{ group: TagGroup; reused: boolean }> {
  const clean = name.trim().replace(/\s+/g, ' ');
  if (!clean) throw Object.assign(new Error('Tên tag không được rỗng'), { code: 'INVALID_REQUEST' });
  const existing = (await listTagGroups(sdk)).find((g) => g.key === tagKey(clean));
  if (existing) return { group: existing, reused: true };
  try {
    await sdk.core.tags.create({ name: clean.slice(0, 100) });
  } catch (e) {
    throw Object.assign(new Error((e as Error).message), { code: errCode(e) || 'INTERNAL' });
  }
  const group = (await listTagGroups(sdk)).find((g) => g.key === tagKey(clean));
  if (!group) throw Object.assign(new Error('Không tạo được tag'), { code: 'INTERNAL' });
  return { group, reused: false };
}

interface LinkRow {
  id: string;
  note_id: string;
  tag_id: string;
}

/** note_id → danh sách nhóm tag (đã gộp bản trùng). */
export async function tagsByNote(sdk: Sdk, groups: TagGroup[]): Promise<Map<string, TagGroup[]>> {
  const owner = new Map<string, TagGroup>();
  for (const g of groups) for (const id of g.ids) owner.set(id, g);
  const links = (await sdk.db.query<LinkRow>('SELECT id, note_id, tag_id FROM note_tags', [])) as LinkRow[];
  const out = new Map<string, TagGroup[]>();
  for (const l of links) {
    const g = owner.get(l.tag_id);
    if (!g) continue; // tag đã bị xoá khỏi core_tags
    const cur = out.get(l.note_id) ?? [];
    if (!cur.includes(g)) out.set(l.note_id, [...cur, g]);
  }
  return out;
}

export async function attachTag(sdk: Sdk, noteId: string, g: TagGroup): Promise<void> {
  const have = (await sdk.db.query<LinkRow>(`SELECT id, note_id, tag_id FROM note_tags WHERE note_id = ? AND tag_id IN (${g.ids.map(() => '?').join(', ')})`, [noteId, ...g.ids])) as LinkRow[];
  if (have.length) return;
  await sdk.db.execute('INSERT INTO note_tags (id, note_id, tag_id) VALUES (?, ?, ?)', [newId(), noteId, g.canonical]);
}

/** Bỏ gắn: xoá mềm MỌI liên kết tới bất kỳ bản trùng nào của nhóm. */
export async function detachTag(sdk: Sdk, noteId: string, g: TagGroup): Promise<void> {
  await sdk.db.execute(`DELETE FROM note_tags WHERE note_id = ? AND tag_id IN (${g.ids.map(() => '?').join(', ')})`, [noteId, ...g.ids]);
}
