// Định dạng thời gian tiếng Việt cho Đọc báo (giờ máy). Thuần — nhận `now` để test được.
const WEEKDAY = ['Chủ nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
const p2 = (n: number) => String(n).padStart(2, '0');

export const hhmm = (ms: number) => {
  const d = new Date(ms);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
};
export const dayKey = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
};
const dm = (ms: number) => {
  const d = new Date(ms);
  return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}`;
};

/** "Hôm nay" · "Hôm qua" · "Thứ Tư 07/10". */
export function dayLabel(ms: number, now: number): string {
  const k = dayKey(ms);
  if (k === dayKey(now)) return 'Hôm nay';
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (k === dayKey(y.getTime())) return 'Hôm qua';
  return `${WEEKDAY[new Date(ms).getDay()]} ${dm(ms)}`;
}

/** "vừa xong" · "5 phút trước" · "2 giờ trước" · "Hôm qua 21:30" · "07/10". */
export function relTime(ms: number | null, now: number): string {
  if (ms === null) return '';
  const diff = now - ms;
  if (diff < 60_000) return 'vừa xong';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} phút trước`;
  if (diff < 24 * 3_600_000 && dayKey(ms) === dayKey(now)) return `${Math.floor(diff / 3_600_000)} giờ trước`;
  const label = dayLabel(ms, now);
  return label === 'Hôm qua' ? `Hôm qua ${hhmm(ms)}` : dm(ms);
}

/** Giờ treo `YYYY-MM-DDTHH:mm` (hợp đồng `calendar.reminder.create`). */
export function wallTime(ms: number): string {
  const d = new Date(ms);
  return `${dayKey(ms)}T${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

export interface QuickTime {
  key: 'hour' | 'afternoon' | 'evening' | 'tomorrow';
  label: string;
  /** Giờ treo của lời nhắc. */
  at: string;
  /** Mô tả cho người đọc: "Chiều nay 17:00". */
  text: string;
}

/** Nút giờ nhanh C27: "Sau 1 giờ · Chiều nay · Tối nay · Sáng mai". Chiều/Tối chỉ hiện khi còn ≥ 5 phút nữa. */
export function quickTimes(now: number): QuickTime[] {
  const at = (h: number, dayOffset = 0) => {
    const d = new Date(now);
    d.setDate(d.getDate() + dayOffset);
    d.setHours(h, 0, 0, 0);
    return d.getTime();
  };
  const out: QuickTime[] = [];
  const hour = now + 3_600_000;
  out.push({ key: 'hour', label: 'Sau 1 giờ', at: wallTime(hour), text: `Sau 1 giờ (${hhmm(hour)})` });
  if (at(17) - now >= 5 * 60_000) out.push({ key: 'afternoon', label: 'Chiều nay', at: wallTime(at(17)), text: 'Chiều nay 17:00' });
  if (at(20) - now >= 5 * 60_000) out.push({ key: 'evening', label: 'Tối nay', at: wallTime(at(20)), text: 'Tối nay 20:00' });
  out.push({ key: 'tomorrow', label: 'Sáng mai', at: wallTime(at(7, 1)), text: 'Sáng mai 07:00' });
  return out;
}
