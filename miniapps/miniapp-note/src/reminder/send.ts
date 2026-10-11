// Gửi intent sang Lịch (hợp đồng `intent-calendar`, ARCHITECTURE §5) + ghi bảng nhớ. Ghi chú không đọc bảng Lịch.
import { saveReminder } from '../data/reminders';
import { errCode, newId, type Sdk } from '../sdk';
import { AT_RE } from './time';

export const NOTE_APP = 'vn.app.note';
export const TITLE_MAX = 200;
export const NO_CALENDAR = 'Chưa cài Lịch — mở Catalog để cài rồi đặt lại (INTENT_NO_HANDLER)';
export const READ_ONLY_MSG = 'Chỉ đọc — chưa đặt được lời nhắc. (READ_ONLY)';

/** Nội dung nhắc mặc định = tiêu đề note, rỗng thì "Ghi chú"; cắt còn ≤ 200 ký tự. */
export const defaultText = (noteTitle: string): string => noteTitle.trim().slice(0, TITLE_MAX) || 'Ghi chú';

/** Mục "Nhắc tôi" chỉ bấm được khi note không ở thùng rác và tenant không chỉ đọc. */
export const canRemind = (s: { readOnly: boolean; trashed: boolean }): boolean => !s.readOnly && !s.trashed;

export type SendResult =
  | { ok: true; id: string; status: 'handled' | 'queued' | 'opened' }
  | { ok: false; reason: 'NO_HANDLER' | 'READ_ONLY' | 'INVALID'; message: string };

export interface SendInput {
  noteId: string;
  /** Nội dung nhắc người dùng nhập (1..200 sau khi trim). */
  text: string;
  /** 'YYYY-MM-DDTHH:mm' */
  at: string;
  /** Giữ nguyên giữa các lần thử lại để Lịch không tạo trùng. */
  id?: string;
}

/**
 * `calendar.reminder.create` → chỉ khi `handled`/`queued` mới ghi `note_reminders`. `INTENT_NO_HANDLER` / `READ_ONLY` trả kết quả
 * có thông điệp (không ghi gì); lỗi khác ném lại cho bên gọi hiện toast.
 */
export async function sendReminder(sdk: Sdk, input: SendInput): Promise<SendResult> {
  const title = input.text.trim().slice(0, TITLE_MAX);
  if (!title) return { ok: false, reason: 'INVALID', message: 'Nhập nội dung nhắc' };
  if (!AT_RE.test(input.at)) return { ok: false, reason: 'INVALID', message: 'Chọn ngày và giờ nhắc' };
  const id = input.id ?? newId();
  try {
    const payload = { id, title, at: input.at, ref: { app: NOTE_APP, id: input.noteId } };
    const { status } = await sdk.intent.send('calendar.reminder.create', payload, { mode: 'create' });
    await saveReminder(sdk, { id, note_id: input.noteId, at_local: input.at, title });
    return { ok: true, id, status };
  } catch (e) {
    const code = errCode(e);
    if (code === 'INTENT_NO_HANDLER') return { ok: false, reason: 'NO_HANDLER', message: NO_CALENDAR };
    if (code === 'READ_ONLY') return { ok: false, reason: 'READ_ONLY', message: READ_ONLY_MSG };
    throw e;
  }
}

/** `calendar.event.open` (mode `open`). Trả thông điệp banner khi Lịch chưa cài, ngược lại chuỗi rỗng; lỗi khác ném lại. */
export async function openInCalendar(sdk: Sdk, eventId: string): Promise<string> {
  try {
    await sdk.intent.send('calendar.event.open', { eventId }, { mode: 'open' });
    return '';
  } catch (e) {
    if (errCode(e) === 'INTENT_NO_HANDLER') return NO_CALENDAR;
    throw e;
  }
}
