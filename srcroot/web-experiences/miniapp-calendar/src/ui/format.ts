// Định dạng tiếng Việt cho ngày / giờ / âm lịch. Thuần.
import { inRange, lunarLabel, lunarText, solarToLunar, type LunarDate } from '../lunar/lunar';
import { addDays, pad2, parseYmd, splitLocal, WEEKDAY_FULL, type Ymd } from '../recur/dates';

export function lunarOfYmd(d: Ymd): LunarDate | null {
  const { y, m, d: dd } = parseYmd(d);
  return inRange(y) ? solarToLunar(y, m, dd) : null;
}

/** Nhãn dưới số dương: "15" hoặc "1/9" (mùng 1). */
export function lunarCell(d: Ymd): { label: string; hl: boolean } {
  const l = lunarOfYmd(d);
  if (!l) return { label: '', hl: false };
  return { label: lunarLabel(l), hl: l.day === 1 || l.day === 15 };
}

export const dm = (d: Ymd) => `${pad2(parseYmd(d).d)}/${pad2(parseYmd(d).m)}`;
export const dmy = (d: Ymd) => `${pad2(parseYmd(d).d)}/${pad2(parseYmd(d).m)}/${parseYmd(d).y}`;

/** "Thứ Hai 12/10". */
export function dayShort(d: Ymd): string {
  const { y, m, d: dd } = parseYmd(d);
  return `${WEEKDAY_FULL[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()]} ${pad2(dd)}/${pad2(m)}`;
}

/** "Thứ Hai 12/10 · 3/9 âm". */
export function dayHeading(d: Ymd): string {
  const l = lunarOfYmd(d);
  return l ? `${dayShort(d)} · ${l.day}/${l.month}${l.leap ? ' nhuận' : ''} âm` : dayShort(d);
}

/** "Thứ Hai, 12/10/2026 · 07:00 · 3/9 âm lịch". */
export function summaryLine(date: Ymd, time: string | null): string {
  const { y, m, d } = parseYmd(date);
  const wd = WEEKDAY_FULL[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const l = lunarOfYmd(date);
  return `${wd}, ${pad2(d)}/${pad2(m)}/${y}${time ? ` · ${time}` : ''}${l ? ` · ${lunarText(l)}` : ''}`;
}

/** Dòng tháng trên đầu S15: "Tháng 10 năm 2026". */
export function monthTitle(d: Ymd): string {
  const { y, m } = parseYmd(d);
  return `Tháng ${m} năm ${y}`;
}

/** "tháng 8 âm lịch" hoặc "tháng 8–9 âm lịch" cho tuần/ngày đang xem. */
export function lunarMonthLine(from: Ymd, to: Ymd): string {
  const a = lunarOfYmd(from);
  const b = lunarOfYmd(to);
  if (!a || !b) return '';
  const nm = (l: LunarDate) => `${l.month}${l.leap ? ' nhuận' : ''}`;
  return a.month === b.month && a.leap === b.leap ? `tháng ${nm(a)} âm lịch` : `tháng ${nm(a)}–${nm(b)} âm lịch`;
}

export const timeOf = (local: string): string => splitLocal(local).time ?? '';

export function weekDays(monday: Ymd): Ymd[] {
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}
