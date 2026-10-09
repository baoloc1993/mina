// Logic biểu mẫu S16 (thuần, test được): mục ↔ biểu mẫu, kiểm lỗi, dựng dòng `events`, vá "chỉ lần này", nút giờ nhanh.
import { addDays, diffDays, isYmd, joinLocal, splitLocal, weekday, type Ymd } from '../recur/dates';
import type { EditPatch, EventRow, Kind, RepeatUnit } from '../recur/model';
import { eventZone, type Env, type Occurrence } from '../recur/occurrences';
import { deviceTimeZoneName } from '../recur/zone';
import { lunarMonthLength, lunarToSolar, nextLunarMonth, solarToLunar } from '../lunar/lunar';

export interface Form {
  kind: Kind;
  title: string;
  allDay: boolean;
  date: Ymd;
  time: string;
  endTime: string;
  fixed: boolean;
  unit: RepeatUnit | null;
  every: number;
  cal: 'solar' | 'lunar';
  until: string;
  alert: number;
}

export interface FormErrors {
  title?: string;
  end?: string;
  every?: string;
  until?: string;
  date?: string;
  time?: string;
}

/** Giờ gợi ý khi thêm mới: giờ tròn kế tiếp. */
export function defaultForm(kind: Kind, date: Ymd, env: Env): Form {
  const now = env.zone.msToLocal(env.now);
  const nowDate = now.slice(0, 10);
  let time = '09:00';
  if (date === nowDate) {
    const h = Number(now.slice(11, 13)) + 1;
    time = `${String(Math.min(h, 23)).padStart(2, '0')}:00`;
  }
  const endH = Math.min(Number(time.slice(0, 2)) + 1, 23);
  return { kind, title: '', allDay: false, date, time, endTime: `${String(endH).padStart(2, '0')}:00`, fixed: false, unit: null, every: 1, cal: 'solar', until: '', alert: 0 };
}

/** Biểu mẫu từ một mục; có `occ` thì điền theo lần xuất hiện đó (giờ hiển thị theo múi giờ máy). */
export function formFromEvent(e: EventRow, occ: Occurrence | null, env: Env): Form {
  const startLocal = occ ? occ.startLocal : e.start_local;
  const endLocal = occ ? occ.endLocal : e.end_local;
  const { date, time } = splitLocal(startLocal);
  const end = endLocal ? splitLocal(endLocal).time : null;
  void env;
  return {
    kind: e.kind,
    title: occ?.title ?? e.title,
    allDay: !!e.all_day,
    date,
    time: e.all_day ? '09:00' : time ?? '09:00',
    endTime: end ?? addHour(time ?? '09:00'),
    fixed: !!e.fixed,
    unit: e.repeat_unit,
    every: e.repeat_every || 1,
    cal: e.repeat_cal,
    until: e.repeat_until ?? '',
    alert: occ?.alertMin ?? e.alert_min,
  };
}

function addHour(t: string): string {
  const h = Math.min(Number(t.slice(0, 2)) + 1, 23);
  return `${String(h).padStart(2, '0')}:${t.slice(3, 5)}`;
}

export function validate(f: Form): FormErrors {
  const err: FormErrors = {};
  if (!f.title.trim()) err.title = 'Nhập tiêu đề';
  else if (f.title.length > 200) err.title = 'Tiêu đề quá dài (tối đa 200 ký tự)';
  if (!isYmd(f.date)) err.date = 'Chọn ngày';
  if (!f.allDay && !/^\d{2}:\d{2}$/.test(f.time)) err.time = 'Chọn giờ';
  if (!f.allDay && f.kind === 'event' && /^\d{2}:\d{2}$/.test(f.endTime) && f.endTime <= f.time) err.end = 'Giờ kết thúc phải sau giờ bắt đầu';
  if (f.unit && (!Number.isInteger(f.every) || f.every < 1 || f.every > 365)) err.every = 'Nhập số từ 1 đến 365';
  if (f.unit && f.until) {
    if (!isYmd(f.until)) err.until = 'Ngày kết thúc không hợp lệ';
    else if (isYmd(f.date) && f.until < f.date) err.until = 'Ngày kết thúc phải sau ngày bắt đầu';
  }
  return err;
}

/** Giờ đã qua (so với `env.now` theo múi giờ máy) — chỉ cảnh báo "sẽ nhắc ngay", vẫn cho lưu. */
export function isPast(f: Form, env: Env): boolean {
  if (f.unit) return false; // mục lặp: lần đã qua hôm nay không kêu lại — lần đầu tiên là lần kế tiếp
  if (f.allDay || !isYmd(f.date) || !/^\d{2}:\d{2}$/.test(f.time)) return false;
  return env.zone.localToMs(joinLocal(f.date, f.time)) < env.now;
}

/** Dòng `events` từ biểu mẫu. `base` có thì giữ id, nguồn, trạng thái xong. */
export function buildRow(f: Form, id: string, base: EventRow | null, env: Env, startDate: Ymd = f.date): EventRow {
  const lunar = f.unit !== null && (f.unit === 'month' || f.unit === 'year') && f.cal === 'lunar';
  const allDay = f.allDay || lunar; // lặp âm lịch luôn cả ngày (nhắc 07:00)
  const fixed = !allDay && f.fixed;
  const start_local = allDay ? startDate : joinLocal(startDate, f.time);
  const end_local = !allDay && f.kind === 'event' ? joinLocal(startDate, f.endTime) : null;
  let lunar_month: number | null = null;
  let lunar_day: number | null = null;
  if (lunar) {
    const l = solarToLunar(Number(startDate.slice(0, 4)), Number(startDate.slice(5, 7)), Number(startDate.slice(8, 10)));
    lunar_month = l.month; // tháng nhuận quy về tháng thường
    lunar_day = l.day;
  }
  return {
    id,
    kind: f.kind,
    title: f.title.trim(),
    all_day: allDay ? 1 : 0,
    start_local,
    end_local,
    fixed: fixed ? 1 : 0,
    start_ms: fixed ? env.zone.localToMs(start_local) : null,
    end_ms: fixed && end_local ? env.zone.localToMs(end_local) : null,
    tz: fixed ? deviceTimeZoneName() : null,
    repeat_unit: f.unit,
    repeat_every: f.unit ? f.every : 1,
    repeat_cal: lunar ? 'lunar' : 'solar',
    repeat_until: f.unit && f.until ? f.until : null,
    lunar_month,
    lunar_day,
    alert_min: f.alert,
    done_at_ms: base?.done_at_ms ?? null,
    src_app: base?.src_app ?? null,
    src_id: base?.src_id ?? null,
  };
}

/** "Tất cả các lần": dời ngày bắt đầu của chuỗi theo độ lệch giữa ngày lần đang sửa và ngày người dùng chọn. */
export function seriesStartDate(base: EventRow, occDate: Ymd, f: Form): Ymd {
  return addDays(splitLocal(base.start_local).date, diffDays(occDate, f.date));
}

/** "Chỉ lần này": chỉ vá những gì đổi so với lần xuất hiện gốc (giờ lưu theo khung của sự kiện). */
export function thisOnlyPatch(f: Form, occ: Occurrence, env: Env): EditPatch {
  const zone = eventZone(occ.event, env);
  const patch: EditPatch = {};
  if (f.title.trim() !== occ.title) patch.title = f.title.trim();
  if (f.alert !== occ.alertMin) patch.alert_min = f.alert;
  if (occ.allDay) {
    if (f.date !== occ.dateLocal) patch.start_local = f.date;
    return patch;
  }
  const startMs = env.zone.localToMs(joinLocal(f.date, f.time));
  if (startMs !== occ.startMs) patch.start_local = zone.msToLocal(startMs);
  if (occ.event.kind === 'event') {
    const endMs = env.zone.localToMs(joinLocal(f.date, f.endTime));
    if (endMs !== occ.endMs) {
      patch.end_local = zone.msToLocal(endMs);
      if (!patch.start_local) patch.start_local = zone.msToLocal(startMs);
    }
  }
  return patch;
}

export interface QuickPick {
  label: string;
  date: Ymd;
  time: string;
}

/** Nút giờ nhanh (C27): Sau 1 giờ · Chiều nay 17:00 (qua 17:00 → 19:00, qua nữa → ẩn) · Sáng mai 07:00 · Cuối tuần (thứ Bảy 07:00). */
export function quickPicks(env: Env): QuickPick[] {
  const now = env.zone.msToLocal(env.now);
  const today = now.slice(0, 10);
  const out: QuickPick[] = [];
  const plus1 = env.zone.msToLocal(env.now + 3_600_000);
  out.push({ label: 'Sau 1 giờ', date: plus1.slice(0, 10), time: plus1.slice(11) });
  const hm = now.slice(11);
  if (hm < '17:00') out.push({ label: 'Chiều nay', date: today, time: '17:00' });
  else if (hm < '19:00') out.push({ label: 'Chiều nay', date: today, time: '19:00' });
  out.push({ label: 'Sáng mai', date: addDays(today, 1), time: '07:00' });
  const wd = weekday(today);
  const toSat = wd === 6 && hm >= '07:00' ? 7 : (6 - wd + 7) % 7;
  out.push({ label: 'Cuối tuần', date: addDays(today, toSat), time: '07:00' });
  return out;
}

/** Hoãn: 10 phút · 1 giờ · sáng mai 07:00 → `until_local` (giờ treo, múi giờ máy). */
export function snoozeOptions(env: Env): { label: string; until: string }[] {
  const now = env.zone.msToLocal(env.now);
  return [
    { label: '10 phút', until: env.zone.msToLocal(env.now + 600_000) },
    { label: '1 giờ', until: env.zone.msToLocal(env.now + 3_600_000) },
    { label: 'Sáng mai', until: joinLocal(addDays(now.slice(0, 10), 1), '07:00') },
  ];
}

const fmt = (y: number, m: number, d: number) => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/**
 * Ngày dương gần nhất (≥ `from`) có ngày âm `day` (và tháng âm `month` nếu có; `null` = bất kỳ tháng — dùng cho lặp tháng).
 * Dùng khi người dùng nhập thẳng "ngày 12 tháng 3 âm" thay vì tự đổi sang ngày dương. Ngày 30 gặp tháng 29 ngày → ngày 29.
 */
export function nextLunarDate(day: number, month: number | null, from: Ymd): Ymd | null {
  const fy = Number(from.slice(0, 4));
  const fl = solarToLunar(fy, Number(from.slice(5, 7)), Number(from.slice(8, 10)));
  if (month !== null) {
    for (let y = fl.year; y <= fl.year + 2; y++) {
      const len = lunarMonthLength(month, y);
      if (len === null) continue;
      const s = lunarToSolar(Math.min(day, len), month, y);
      if (s && fmt(s.y, s.m, s.d) >= from) return fmt(s.y, s.m, s.d);
    }
    return null;
  }
  let cur = { month: fl.month, year: fl.year, leap: fl.leap };
  for (let i = 0; i < 16; i++) {
    const len = lunarMonthLength(cur.month, cur.year, cur.leap);
    if (len !== null) {
      const s = lunarToSolar(Math.min(day, len), cur.month, cur.year, cur.leap);
      if (s && fmt(s.y, s.m, s.d) >= from) return fmt(s.y, s.m, s.d);
    }
    cur = nextLunarMonth(cur.month, cur.year, cur.leap);
  }
  return null;
}

/** Nhãn thời điểm hoãn: "hôm nay 21:07" · "ngày mai 07:00" · "11/10 07:00". */
export function whenText(ms: number, env: Env): string {
  const l = env.zone.msToLocal(ms);
  const d = l.slice(0, 10);
  const today = env.zone.msToLocal(env.now).slice(0, 10);
  const hm = l.slice(11);
  if (d === today) return `hôm nay ${hm}`;
  if (d === addDays(today, 1)) return `ngày mai ${hm}`;
  return `${d.slice(8, 10)}/${d.slice(5, 7)} ${hm}`;
}
