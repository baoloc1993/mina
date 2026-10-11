// Logic thuần của "Nhắc tôi" (S18, C27): nút nhanh, định dạng, kiểm giờ đã qua. `at` luôn là chuỗi giờ treo 'YYYY-MM-DDTHH:mm'
// (không múi giờ — đúng hợp đồng `calendar.reminder.create`). Mọi hàm nhận `now` để test được.
const pad = (n: number) => String(n).padStart(2, '0');
export const WEEKDAYS = ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
export const AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

export type QuickKey = 'h1' | 'pm' | 'am' | 'we';
export interface QuickOption {
  key: QuickKey;
  label: string;
  /** 'YYYY-MM-DDTHH:mm' */
  at: string;
}

/** Date (giờ máy) → 'YYYY-MM-DDTHH:mm'. */
export function toAt(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 'YYYY-MM-DDTHH:mm' → Date giờ máy; null nếu sai định dạng / ngày không có thật (vd 31/02). */
export function parseAt(at: string): Date | null {
  if (!AT_RE.test(at)) return null;
  const [y, mo, d] = at.slice(0, 10).split('-').map(Number);
  const [h, mi] = at.slice(11).split(':').map(Number);
  const date = new Date(y, mo - 1, d, h, mi, 0, 0);
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d && date.getHours() === h ? date : null;
}

export const joinAt = (date: string, time: string): string => (date && time ? `${date}T${time}` : '');
export const splitAt = (at: string): { date: string; time: string } => (at ? { date: at.slice(0, 10), time: at.slice(11, 16) } : { date: '', time: '' });

const atTime = (base: Date, addDays: number, h: number, m = 0) => new Date(base.getFullYear(), base.getMonth(), base.getDate() + addDays, h, m, 0, 0);

/**
 * Bốn nút nhanh (C27), theo thứ tự hiển thị.
 * - Sau 1 giờ: now + 60 phút, làm tròn xuống phút.
 * - Chiều nay: 17:00; nếu 17:00 đã qua thì 19:00; qua cả 19:00 thì ẨN (không có "chiều nay" để chọn — người dùng có "Sáng mai").
 * - Sáng mai: 07:00 ngày kế.
 * - Cuối tuần: thứ Bảy 07:00 gần nhất còn ở tương lai (hôm nay là thứ Bảy mà đã quá 07:00 → thứ Bảy tuần sau).
 */
export function quickOptions(now: Date = new Date()): QuickOption[] {
  const out: QuickOption[] = [];
  out.push({ key: 'h1', label: 'Sau 1 giờ', at: toAt(new Date(Math.floor(now.getTime() / 60_000) * 60_000 + 3_600_000)) });
  const five = atTime(now, 0, 17);
  const seven = atTime(now, 0, 19);
  if (five.getTime() > now.getTime()) out.push({ key: 'pm', label: 'Chiều nay', at: toAt(five) });
  else if (seven.getTime() > now.getTime()) out.push({ key: 'pm', label: 'Chiều nay', at: toAt(seven) });
  out.push({ key: 'am', label: 'Sáng mai', at: toAt(atTime(now, 1, 7)) });
  let add = (6 - now.getDay() + 7) % 7;
  if (add === 0 && atTime(now, 0, 7).getTime() <= now.getTime()) add = 7;
  out.push({ key: 'we', label: 'Cuối tuần', at: toAt(atTime(now, add, 7)) });
  return out;
}

/** "Thứ Hai 12/10 07:00" — dòng "Lời nhắc:" ở S12. Chuỗi sai định dạng trả nguyên văn. */
export function formatShort(at: string): string {
  const d = parseAt(at);
  return d ? `${WEEKDAYS[d.getDay()]} ${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}` : at;
}

/** "Thứ Hai, 12/10/2026 · 07:00" — dòng tóm tắt dưới hai ô ngày/giờ (C27). */
export function formatSummary(date: string, time: string): string {
  if (!date) return 'Chưa chọn ngày';
  const d = parseAt(`${date}T${time || '00:00'}`);
  if (!d) return 'Ngày chưa hợp lệ';
  return `${WEEKDAYS[d.getDay()]}, ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}${time ? ` · ${time}` : ''}`;
}

/** Giờ đã qua so với `now` (so đến phút). Chuỗi rỗng / sai định dạng → false. */
export function isPast(at: string, now: Date = new Date()): boolean {
  const d = parseAt(at);
  return !!d && d.getTime() < Math.floor(now.getTime() / 60_000) * 60_000;
}

export const PAST_WARNING = 'Giờ này đã qua — sẽ nhắc ngay';
