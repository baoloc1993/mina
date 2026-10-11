// Bảng `note_reminders` (migration 002): bản ghi nhớ phía Ghi chú cho lời nhắc đã gửi sang Lịch. Nguồn sự thật nằm ở Lịch.
import type { Sdk } from '../sdk';

export interface ReminderRow {
  id: string;
  note_id: string;
  at_local: string;
  title: string;
}

/** Các lời nhắc chưa xoá mềm của một note, mới nhất đầu (bridge tự lọc `deleted_at`). */
export async function listReminders(sdk: Sdk, noteId: string): Promise<ReminderRow[]> {
  return (await sdk.db.query<ReminderRow>('SELECT id, note_id, at_local, title FROM note_reminders WHERE note_id = ? ORDER BY created_at DESC, id', [noteId])) as ReminderRow[];
}

/** Ghi dòng nhớ; cùng `id` (gửi lại) → cập nhật chứ không chèn thêm. Dòng đã bị người dùng bỏ (xoá mềm) thì giữ nguyên. */
export async function saveReminder(sdk: Sdk, r: ReminderRow): Promise<void> {
  const have = (await sdk.db.query<{ id: string; deleted_at: string | null }>('SELECT id, deleted_at FROM note_reminders WHERE id = ?', [r.id], { includeDeleted: true })) as { id: string; deleted_at: string | null }[];
  if (!have.length) await sdk.db.execute('INSERT INTO note_reminders (id, note_id, at_local, title) VALUES (?, ?, ?, ?)', [r.id, r.note_id, r.at_local, r.title]);
  else if (!have[0].deleted_at) await sdk.db.execute('UPDATE note_reminders SET at_local = ?, title = ? WHERE id = ?', [r.at_local, r.title, r.id]);
}

/** Bỏ dòng nhớ (xoá mềm). KHÔNG gửi gì sang Lịch. */
export async function forgetReminder(sdk: Sdk, id: string): Promise<void> {
  await sdk.db.execute('DELETE FROM note_reminders WHERE id = ?', [id]);
}
