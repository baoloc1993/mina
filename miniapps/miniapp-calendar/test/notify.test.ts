// AC-2 / AC-3: đối chiếu thông báo (thuần) — đúng 40 cái ĐẦU, không kêu lại, hủy khi xong, hoãn, giờ đã qua.
import { describe, expect, it } from 'vitest';
import { desiredNotifications, GRACE_MS, MAX_UPCOMING, planNotify, type NotifyItem } from '../src/notify/plan';
import { envAt, ev, ov, VN } from './fixtures';

const NOW = '2026-10-09T08:00';
const env = envAt(NOW);
const t = (local: string) => VN.localToMs(local);

describe('desiredNotifications', () => {
  it('bộ lặp hằng ngày 400 ngày → đúng 40 cái ĐẦU TIÊN (không phải 40 cái xa nhất)', () => {
    const e = ev({ kind: 'reminder', title: 'Chuỗi thử', start_local: '2026-10-01T09:00', repeat_unit: 'day', repeat_until: '2027-11-05' });
    const d = desiredNotifications([e], [], env);
    expect(d).toHaveLength(MAX_UPCOMING);
    expect(d[0].id).toBe(`${e.id}|2026-10-09`);
    expect(d[39].id).toBe(`${e.id}|2026-11-17`);
    expect(d.map((x) => x.at)).toEqual([...d.map((x) => x.at)].sort((a, b) => a - b));
  });

  it('nhắc trước: 14:00 nhắc trước 1 giờ kêu lúc 13:00; cả ngày kêu 07:00', () => {
    const a = ev({ title: 'Khám răng', start_local: '2026-10-14T14:00', end_local: '2026-10-14T15:00', alert_min: 60 });
    const b = ev({ title: 'Giỗ', all_day: 1, start_local: '2026-10-20' });
    const [x, y] = desiredNotifications([a, b], [], env);
    expect(x.at).toBe(t('2026-10-14T13:00'));
    expect(x.body).toBe('Sự kiện · 14:00–15:00');
    expect(y.at).toBe(t('2026-10-20T07:00'));
    expect(y.body).toBe('Sự kiện · cả ngày');
  });

  it('bỏ lần đã xong / đã skip; hoãn → kêu lúc giờ hoãn', () => {
    const r = ev({ kind: 'reminder', title: 'Thuốc', start_local: '2026-10-10T07:00', repeat_unit: 'day', repeat_until: '2026-10-13' });
    const ovs = [ov(r.id, '2026-10-10', 'done', { at_ms: 1 }), ov(r.id, '2026-10-11', 'skip'), ov(r.id, '2026-10-12', 'snooze', { until_local: '2026-10-12T08:30' })];
    const d = desiredNotifications([r], ovs, env);
    expect(d.map((x) => [x.id.slice(-10), x.at])).toEqual([['2026-10-12', t('2026-10-12T08:30')], ['2026-10-13', t('2026-10-13T07:00')]]);
  });

  it('lần đã qua quá 2 phút không bao giờ được đặt lại; trong 2 phút thì còn; ép (force) thì kêu ngay', () => {
    const past = ev({ kind: 'reminder', title: 'Đã qua', start_local: '2026-10-09T07:00' });
    expect(desiredNotifications([past], [], env)).toHaveLength(0);
    const justNow = ev({ kind: 'reminder', title: 'Vừa xong', start_local: '2026-10-09T07:59' });
    expect(desiredNotifications([justNow], [], env)).toHaveLength(1);
    const forced = desiredNotifications([past], [], env, { force: new Set([`${past.id}|2026-10-09`]) });
    expect(forced).toHaveLength(1);
    expect(forced[0].at).toBe(env.now);
  });

  it('tiêu đề 200 ký tự được cắt còn ≤ 100 khi đặt (bridge giới hạn)', () => {
    const e = ev({ title: 'x'.repeat(200), start_local: '2026-10-12T09:00' });
    expect(desiredNotifications([e], [], env)[0].title.length).toBeLessThanOrEqual(100);
  });

  it('đổi múi giờ máy: giờ treo 07:00 vẫn 07:00 giờ mới → at đổi, id không đổi', () => {
    const r = ev({ kind: 'reminder', start_local: '2026-10-10T07:00' });
    const a = desiredNotifications([r], [], envAt(NOW, VN))[0];
    const b = desiredNotifications([r], [], { zone: envAt(NOW).zone, now: env.now })[0];
    expect(a.id).toBe(b.id);
  });
});

describe('planNotify', () => {
  const e = ev({ kind: 'reminder', title: 'Thuốc', start_local: '2026-10-10T07:00', repeat_unit: 'day', repeat_until: '2026-10-12' });
  const want = desiredNotifications([e], [], env);
  const asList = (): NotifyItem[] => want.map((d) => ({ ...d }));

  it('danh sách trống → đặt tất cả; đối chiếu lần hai → không làm gì (idempotent)', () => {
    const p1 = planNotify(want, [], env.now);
    expect(p1.schedule).toHaveLength(3);
    expect(planNotify(want, asList(), env.now)).toEqual({ schedule: [], cancel: [] });
  });

  it('máy A đánh dấu xong lần 10/10 → máy B (đã đặt đủ) huỷ đúng lần đó (AC-3)', () => {
    const after = desiredNotifications([e], [ov(e.id, '2026-10-10', 'done', { at_ms: 1 })], env);
    const p = planNotify(after, asList(), env.now);
    expect(p.cancel).toEqual([`${e.id}|2026-10-10`]);
    expect(p.schedule).toEqual([]);
  });

  it('dời giờ ở máy khác → schedule lại (thay id trùng)', () => {
    const after = desiredNotifications([e], [ov(e.id, '2026-10-11', 'edit', { start_local: '2026-10-11T09:00' })], env);
    const p = planNotify(after, asList(), env.now);
    expect(p.schedule.map((d) => d.id)).toEqual([`${e.id}|2026-10-11`]);
    expect(p.schedule[0].at).toBe(t('2026-10-11T09:00'));
  });

  it('thông báo đã kêu (at ≤ now) còn trong list: không đặt lại, không huỷ — dù mục vẫn mong muốn', () => {
    const later = envAt('2026-10-10T07:30');
    const wantLater = desiredNotifications([e], [], later);
    const list: NotifyItem[] = [{ id: `${e.id}|2026-10-10`, at: t('2026-10-10T07:00'), title: 'Thuốc', body: 'x', ref: `${e.id}|2026-10-10` }];
    const p = planNotify(wantLater, list, later.now);
    expect(p.schedule.map((d) => d.id)).not.toContain(`${e.id}|2026-10-10`);
    expect(p.cancel).toEqual([]);
  });

  it('lời nhắc vừa tạo với giờ đã qua (ép) → đặt at = now một lần, lần sau không kêu lại', () => {
    const past = ev({ kind: 'reminder', title: 'Qua rồi', start_local: '2026-10-09T06:00' });
    const w = desiredNotifications([past], [], env, { force: new Set([`${past.id}|2026-10-09`]) });
    const p1 = planNotify(w, [], env.now);
    expect(p1.schedule).toHaveLength(1);
    expect(p1.schedule[0].at).toBe(env.now);
    // shell đã kêu: dòng còn trong list với at = now; đối chiếu sau 1 phút với force vẫn bật → không đặt lại
    const list: NotifyItem[] = [{ ...p1.schedule[0] }];
    expect(planNotify(w, list, env.now + 60_000).schedule).toEqual([]);
  });

  it('mục bị xoá → thông báo còn chờ bị huỷ; giới hạn 40: cái thứ 41 vào danh sách thì cái xa nhất bị huỷ', () => {
    const big = ev({ kind: 'reminder', title: 'Dài', start_local: '2026-10-10T09:00', repeat_unit: 'day' });
    const w1 = desiredNotifications([big], [], env);
    const w2 = desiredNotifications([big], [ov(big.id, '2026-10-10', 'skip')], env);
    const p = planNotify(w2, w1.map((d) => ({ ...d })), env.now);
    expect(p.cancel).toEqual([`${big.id}|2026-10-10`]);
    expect(p.schedule.map((d) => d.id)).toEqual([`${big.id}|${w2[39].id.slice(-10)}`]);
    expect(GRACE_MS).toBe(120_000);
  });
});
