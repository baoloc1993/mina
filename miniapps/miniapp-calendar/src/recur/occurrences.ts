// Mở rộng quy tắc lặp — hàm THUẦN `occurrences(event, overrides, from, to, env)`.
// Không lưu từng lần lặp: mỗi mục là một quy tắc + các ngoại lệ "chỉ lần này". Lần xuất hiện được định danh bằng `occ_date`
// (ngày dương trong KHUNG của sự kiện: giờ treo → ngày theo máy, giờ cố định → ngày theo múi giờ gốc) nên ổn định giữa các máy.
import { ALL_DAY_NOTIFY_TIME, type EditPatch, type EventRow, type OverrideRow } from './model';
import { addDays, daysInMonth, diffDays, fmtYmd, isLocal, parseYmd, splitLocal, type Ymd } from './dates';
import { deviceZone, zoneOf, type Zone } from './zone';
import { inRange, lunarMonthLength, lunarToSolar, nextLunarMonth, solarToLunar } from '../lunar/lunar';

export interface Env {
  zone: Zone;
  now: number;
}
export const defaultEnv = (): Env => ({ zone: deviceZone, now: Date.now() });

export interface Occurrence {
  key: string;
  eventId: string;
  occDate: Ymd;
  event: EventRow;
  kind: EventRow['kind'];
  title: string;
  allDay: boolean;
  /** Thời điểm bắt đầu (epoch ms). Cả ngày: 07:00 giờ máy của `dateLocal`. */
  startMs: number;
  endMs: number | null;
  /** Ngày hiển thị theo múi giờ máy. */
  dateLocal: Ymd;
  startLocal: string;
  endLocal: string | null;
  alertMin: number;
  done: boolean;
  doneAtMs: number | null;
  snoozeUntilMs: number | null;
  edited: boolean;
  recurring: boolean;
}

const MAX_ITER = 5000;
const json = (s: string): Record<string, unknown> => {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

export function eventZone(ev: EventRow, env: Env): Zone {
  return ev.fixed && ev.tz ? zoneOf(ev.tz, env.zone) : env.zone;
}

/** Các ngày (khung sự kiện) có lần xuất hiện theo QUY TẮC trong [from, to], chưa áp ngoại lệ. */
export function ruleDates(ev: EventRow, from: Ymd, to: Ymd): Ymd[] {
  const start = splitLocal(ev.start_local).date;
  const until = ev.repeat_until ? (ev.repeat_until >= start ? ev.repeat_until : start) : null;
  const hi = until && until < to ? until : to;
  const out: Ymd[] = [];
  const push = (d: Ymd) => {
    if (d >= start && d >= from && d <= hi) out.push(d);
  };
  if (!ev.repeat_unit) {
    push(start);
    return out;
  }
  const n = Math.max(1, ev.repeat_every || 1);
  if (hi < from || hi < start) return out;

  if (ev.repeat_cal === 'lunar' && (ev.repeat_unit === 'month' || ev.repeat_unit === 'year')) {
    const sp = parseYmd(start);
    if (!inRange(sp.y)) return out;
    const anchor = solarToLunar(sp.y, sp.m, sp.d);
    const day = ev.lunar_day ?? anchor.day;
    const month = ev.lunar_month ?? anchor.month;
    push(start); // lần đầu luôn là chính ngày bắt đầu (kể cả khi nó nằm trong tháng nhuận)
    const hiP = parseYmd(hi);
    const maxYear = Math.min(hiP.y + 1, 2099);
    if (ev.repeat_unit === 'year') {
      for (let k = 0, y = anchor.year; y <= maxYear && k < MAX_ITER; k++, y += n) {
        const len = lunarMonthLength(month, y);
        if (len === null) continue;
        const s = lunarToSolar(Math.min(day, len), month, y);
        if (s) push(fmtYmd(s.y, s.m, s.d));
      }
    } else {
      let cur = { month: anchor.month, year: anchor.year, leap: anchor.leap };
      for (let k = 0; cur.year <= maxYear && k < MAX_ITER; k++) {
        if (k % n === 0) {
          const len = lunarMonthLength(cur.month, cur.year, cur.leap);
          if (len !== null) {
            const s = lunarToSolar(Math.min(day, len), cur.month, cur.year, cur.leap);
            if (s) push(fmtYmd(s.y, s.m, s.d));
          }
        }
        cur = nextLunarMonth(cur.month, cur.year, cur.leap);
      }
    }
    return [...new Set(out)].sort();
  }

  const sp = parseYmd(start);
  switch (ev.repeat_unit) {
    case 'day':
    case 'week': {
      const step = n * (ev.repeat_unit === 'week' ? 7 : 1);
      const k0 = Math.max(0, Math.floor(diffDays(start, from) / step));
      for (let k = k0, i = 0; i < MAX_ITER; k++, i++) {
        const d = addDays(start, k * step);
        if (d > hi) break;
        push(d);
      }
      break;
    }
    case 'month': {
      const fp = parseYmd(from);
      const monthsApart = (fp.y - sp.y) * 12 + (fp.m - sp.m);
      const k0 = Math.max(0, Math.floor(monthsApart / n) - 1);
      for (let k = k0, i = 0; i < MAX_ITER; k++, i++) {
        const total = sp.m - 1 + k * n;
        const y = sp.y + Math.floor(total / 12);
        const m = (total % 12) + 1;
        const d = fmtYmd(y, m, Math.min(sp.d, daysInMonth(y, m))); // ngày 29–31 ở tháng ngắn → ngày cuối tháng
        if (d > hi) break;
        push(d);
      }
      break;
    }
    case 'year': {
      const fp = parseYmd(from);
      const k0 = Math.max(0, Math.floor((fp.y - sp.y) / n) - 1);
      for (let k = k0, i = 0; i < MAX_ITER; k++, i++) {
        const y = sp.y + k * n;
        const d = fmtYmd(y, sp.m, Math.min(sp.d, daysInMonth(y, sp.m)));
        if (d > hi) break;
        push(d);
      }
      break;
    }
  }
  return out;
}

interface Merged {
  skip: boolean;
  edit: EditPatch | null;
  doneAt: number | null;
  snoozeUntil: string | null;
}

/** Gộp các dòng ngoại lệ cùng `occ_date` (hai máy có thể tạo trùng): skip thắng tất cả; còn lại mỗi loại lấy dòng có id nhỏ nhất. */
export function mergeOverrides(ovs: OverrideRow[]): Map<Ymd, Merged> {
  const by = new Map<Ymd, OverrideRow[]>();
  for (const o of ovs) by.set(o.occ_date, [...(by.get(o.occ_date) ?? []), o]);
  const out = new Map<Ymd, Merged>();
  for (const [d, rows] of by) {
    const pick = (a: OverrideRow['action']) => rows.filter((r) => r.action === a).sort((x, y) => (x.id < y.id ? -1 : 1))[0];
    const edit = pick('edit');
    const done = pick('done');
    const snooze = pick('snooze');
    const until = snooze ? json(snooze.patch).until_local : null;
    out.set(d, {
      skip: rows.some((r) => r.action === 'skip'),
      edit: edit ? (json(edit.patch) as EditPatch) : null,
      doneAt: done ? Number(json(done.patch).at_ms ?? 0) || 1 : null,
      snoozeUntil: isLocal(until) ? until : null,
    });
  }
  return out;
}

/** Khoảng đệm quanh cửa sổ (ngày) cho lần xuất hiện bị dời sang cửa sổ khác hoặc giờ cố định lệch ngày. */
const PAD = 2;

export function occurrences(ev: EventRow, ovs: OverrideRow[], from: Ymd, to: Ymd, env: Env = defaultEnv()): Occurrence[] {
  const zone = eventZone(ev, env);
  const merged = mergeOverrides(ovs.filter((o) => o.event_id === ev.id));
  const recurring = !!ev.repeat_unit;
  const dates = new Set(ruleDates(ev, addDays(from, -PAD), addDays(to, PAD)));
  // lần bị dời giờ (edit) có thể rơi vào cửa sổ dù ngày gốc nằm ngoài
  for (const [d, m] of merged) {
    if (m.edit?.start_local && !dates.has(d) && ruleDates(ev, d, d).length) {
      const nd = splitLocal(m.edit.start_local).date;
      if (nd >= addDays(from, -PAD) && nd <= addDays(to, PAD)) dates.add(d);
    }
  }
  const out: Occurrence[] = [];
  const startParts = splitLocal(ev.start_local);
  const startTime = startParts.time ?? ALL_DAY_NOTIFY_TIME;
  // độ dài (ms) của sự kiện có giờ kết thúc
  let duration: number | null = null;
  if (!ev.all_day && ev.end_local) duration = Math.max(0, zone.localToMs(ev.end_local) - zone.localToMs(ev.start_local));

  for (const occ of dates) {
    const m = merged.get(occ);
    if (m?.skip) continue;
    const patch = m?.edit ?? null;
    const title = patch?.title ?? ev.title;
    const allDay = !!ev.all_day;
    let startLocal = allDay ? occ : `${occ}T${startTime}`;
    if (patch?.start_local) startLocal = allDay ? splitLocal(patch.start_local).date : patch.start_local;
    let startMs: number;
    let endMs: number | null = null;
    if (allDay) {
      startMs = env.zone.localToMs(`${splitLocal(startLocal).date}T${ALL_DAY_NOTIFY_TIME}`);
    } else {
      startMs = zone.localToMs(startLocal);
      if (patch && 'end_local' in patch) endMs = patch.end_local ? zone.localToMs(patch.end_local) : null;
      else if (duration !== null) endMs = startMs + duration;
    }
    const dispStart = allDay ? `${splitLocal(startLocal).date}T${ALL_DAY_NOTIFY_TIME}` : env.zone.msToLocal(startMs);
    const dateLocal = splitLocal(dispStart).date;
    if (dateLocal < from || dateLocal > to) continue;
    // đã xong: lần lặp → ngoại lệ done; mục không lặp → done_at_ms
    const doneAt = m?.doneAt ?? (!recurring && ev.done_at_ms ? ev.done_at_ms : null);
    out.push({
      key: `${ev.id}|${occ}`,
      eventId: ev.id,
      occDate: occ,
      event: ev,
      kind: ev.kind,
      title,
      allDay,
      startMs,
      endMs,
      dateLocal,
      startLocal: dispStart,
      endLocal: endMs !== null ? env.zone.msToLocal(endMs) : null,
      alertMin: patch?.alert_min ?? ev.alert_min,
      done: doneAt !== null,
      doneAtMs: doneAt,
      snoozeUntilMs: m?.snoozeUntil ? env.zone.localToMs(m.snoozeUntil) : null,
      edited: !!patch,
      recurring,
    });
  }
  return out.sort(compareOcc);
}

/** Cả ngày trước, rồi theo giờ, rồi theo tiêu đề. */
export function compareOcc(a: Occurrence, b: Occurrence): number {
  if (a.dateLocal !== b.dateLocal) return a.dateLocal < b.dateLocal ? -1 : 1;
  if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
  if (a.startMs !== b.startMs) return a.startMs - b.startMs;
  return a.title.localeCompare(b.title, 'vi');
}

export function occurrencesAll(events: EventRow[], ovs: OverrideRow[], from: Ymd, to: Ymd, env: Env = defaultEnv()): Occurrence[] {
  const byEvent = new Map<string, OverrideRow[]>();
  for (const o of ovs) byEvent.set(o.event_id, [...(byEvent.get(o.event_id) ?? []), o]);
  const out: Occurrence[] = [];
  for (const ev of events) out.push(...occurrences(ev, byEvent.get(ev.id) ?? [], from, to, env));
  return out.sort(compareOcc);
}

type RepeatFields = Pick<EventRow, 'repeat_unit' | 'repeat_every' | 'repeat_cal' | 'repeat_until' | 'lunar_month' | 'lunar_day'>;

/** Tóm tắt quy tắc lặp bằng tiếng Việt: "Mỗi năm vào 12/3 âm lịch", "Mỗi 2 tuần, đến 31/12/2026". */
export function repeatSummary(ev: RepeatFields): string {
  if (!ev.repeat_unit) return 'Không lặp';
  const n = Math.max(1, ev.repeat_every || 1);
  const until = ev.repeat_until ? `, đến ${ev.repeat_until.slice(8, 10)}/${ev.repeat_until.slice(5, 7)}/${ev.repeat_until.slice(0, 4)}` : '';
  const unit = { day: 'ngày', week: 'tuần', month: 'tháng', year: 'năm' }[ev.repeat_unit];
  const every = n === 1 ? `Mỗi ${unit}` : `Mỗi ${n} ${unit}`;
  if (ev.repeat_cal === 'lunar' && ev.lunar_day) {
    if (ev.repeat_unit === 'year') return `${every} vào ${ev.lunar_day}/${ev.lunar_month} âm lịch${until}`;
    return `${every} vào ngày ${ev.lunar_day} âm lịch${until}`;
  }
  return `${every}${until}`;
}
