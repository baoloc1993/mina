// Thông báo = ĐỐI CHIẾU, không phải sự kiện (ARCHITECTURE.md §6 "Đối chiếu thông báo", DECISIONS vòng 5).
// Hai hàm thuần: `desiredNotifications` tính tập thông báo mong muốn, `planNotify` so với `notify.list()` → schedule / cancel.
// Chạy lại bao nhiêu lần cũng cho cùng kết quả (idempotent) nên mọi đường kích hoạt (mở app, resume, lưu, sync, shell nạp nền) dùng chung.
import { addDays, splitLocal } from '../recur/dates';
import { occurrencesAll, type Env, type Occurrence } from '../recur/occurrences';
import type { EventRow, OverrideRow } from '../recur/model';

export interface NotifyItem {
  id: string;
  at: number;
  title: string;
  body: string;
  ref: string | null;
}
export type Desired = NotifyItem & { ref: string };

/** Số lần xuất hiện sắp tới Lịch đặt (shell giữ ≤ 50 mỗi app — chừa chỗ cho lần đặt thêm). */
export const MAX_UPCOMING = 40;
export const HORIZON_DAYS = 366;
/** Lần đã qua quá ngưỡng này không bao giờ được đặt lại (không "kêu lại" sau mỗi lần đối chiếu). */
export const GRACE_MS = 2 * 60_000;
/** Bridge `notify.schedule` giới hạn tiêu đề ≤ 100, nội dung ≤ 500. */
export const TITLE_MAX = 100;
export const BODY_MAX = 500;

export const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const hhmm = (local: string) => splitLocal(local).time ?? '';

export function bodyOf(o: Occurrence): string {
  if (o.allDay) return o.kind === 'reminder' ? 'Lời nhắc · cả ngày' : 'Sự kiện · cả ngày';
  const range = o.endLocal ? `${hhmm(o.startLocal)}–${hhmm(o.endLocal)}` : hhmm(o.startLocal);
  return `${o.kind === 'reminder' ? 'Lời nhắc' : 'Sự kiện'} · ${range}`;
}

/** Lúc kêu của một lần xuất hiện: hoãn → giờ hoãn tới; còn lại = thời điểm − nhắc trước. */
export function fireAtOf(o: Occurrence): number {
  return o.snoozeUntilMs ?? o.startMs - o.alertMin * 60_000;
}

export interface DesiredOpts {
  limit?: number;
  horizonDays?: number;
  /** Khoá lần xuất hiện (`eventId|occDate`) phải kêu NGAY dù giờ đã qua (vừa tạo / vừa nhận từ app khác). */
  force?: Set<string>;
}

export function desiredNotifications(events: EventRow[], ovs: OverrideRow[], env: Env, opts: DesiredOpts = {}): Desired[] {
  const limit = opts.limit ?? MAX_UPCOMING;
  const today = env.zone.msToLocal(env.now).slice(0, 10);
  const all = occurrencesAll(events, ovs, addDays(today, -2), addDays(today, (opts.horizonDays ?? HORIZON_DAYS) + 2), env);
  const out: Desired[] = [];
  for (const o of all) {
    if (o.done) continue;
    const f = fireAtOf(o);
    const forced = opts.force?.has(o.key) ?? false;
    if (f < env.now - GRACE_MS && !forced) continue;
    out.push({ id: o.key, at: forced && f < env.now ? env.now : f, title: cut(o.title || 'Lịch', TITLE_MAX), body: cut(bodyOf(o), BODY_MAX), ref: o.key });
  }
  return out.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1)).slice(0, limit);
}

export interface Plan {
  schedule: Desired[];
  cancel: string[];
}

/**
 * So tập mong muốn với danh sách shell đang giữ.
 * - có trong list, đã tới giờ (`at ≤ now`): coi như đã kêu — chỉ đặt lại khi giờ mong muốn dời sang TƯƠNG LAI;
 * - có trong list, còn chờ: lệch giờ / chữ → `schedule` (id trùng = thay);
 * - chưa có: giờ còn ở tương lai hoặc vừa qua trong GRACE (hoặc bị ép) → `schedule` (giờ đã qua đặt `at = now` để kêu ngay);
 * - có trong list, còn chờ, mà không còn mong muốn (xong / xoá / dời xa quá 40) → `cancel`; dòng đã kêu để shell tự dọn.
 */
export function planNotify(desired: Desired[], current: NotifyItem[], now: number): Plan {
  const cur = new Map(current.map((c) => [c.id, c]));
  const want = new Set(desired.map((d) => d.id));
  const schedule: Desired[] = [];
  for (const d of desired) {
    const e = cur.get(d.id);
    if (!e) {
      schedule.push({ ...d, at: Math.max(d.at, now) });
    } else if (e.at <= now) {
      if (d.at > now) schedule.push(d);
    } else if (e.at !== d.at || e.title !== d.title || e.body !== d.body || e.ref !== d.ref) {
      schedule.push({ ...d, at: Math.max(d.at, now) });
    }
  }
  const cancel = current.filter((c) => !want.has(c.id) && c.at > now).map((c) => c.id);
  return { schedule, cancel };
}
