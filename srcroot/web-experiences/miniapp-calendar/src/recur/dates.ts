// Ngày dương dạng chuỗi `YYYY-MM-DD` và giờ địa phương `YYYY-MM-DDTHH:mm` — thuần, không phụ thuộc múi giờ máy.
// Mọi phép cộng ngày đi qua Date.UTC nên không dính giờ mùa hè / đổi múi giờ.
export type Ymd = string;

export const pad2 = (n: number) => String(n).padStart(2, '0');
export const fmtYmd = (y: number, m: number, d: number): Ymd => `${String(y).padStart(4, '0')}-${pad2(m)}-${pad2(d)}`;

export function parseYmd(s: Ymd): { y: number; m: number; d: number } {
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  return { y, m, d };
}

export const isYmd = (s: unknown): s is Ymd => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
export const isLocal = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s);

/** Số ngày kể từ 1970-01-01 (UTC) của một ngày dương. */
export function dayNumber(s: Ymd): number {
  const { y, m, d } = parseYmd(s);
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}
export function fromDayNumber(n: number): Ymd {
  const t = new Date(n * 86_400_000);
  return fmtYmd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}
export const addDays = (s: Ymd, n: number): Ymd => fromDayNumber(dayNumber(s) + n);
export const diffDays = (a: Ymd, b: Ymd): number => dayNumber(b) - dayNumber(a);
export const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();
/** 0 = Chủ nhật … 6 = Thứ Bảy. */
export const weekday = (s: Ymd): number => (((dayNumber(s) + 4) % 7) + 7) % 7;
/** Thứ Hai đầu tuần chứa ngày `s`. */
export const mondayOf = (s: Ymd): Ymd => addDays(s, -((weekday(s) + 6) % 7));

export const splitLocal = (s: string): { date: Ymd; time: string | null } => ({ date: s.slice(0, 10), time: s.length >= 16 ? s.slice(11, 16) : null });
export const joinLocal = (date: Ymd, time: string): string => `${date}T${time}`;

export const WEEKDAY_FULL = ['Chủ nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
export const WEEKDAY_SHORT = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
