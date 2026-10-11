// AC-1 (lặp dương, ngoại lệ) + AC-5 (lặp âm lịch) + AC-2 (giờ treo / giờ cố định) — hàm thuần occurrences().
import { describe, expect, it } from 'vitest';
import { occurrences, repeatSummary, ruleDates } from '../src/recur/occurrences';
import { lunarToSolar, solarToLunar } from '../src/lunar/lunar';
import { envAt, ev, JP, ov, VN } from './fixtures';

const env = envAt('2026-10-09T08:00');
const days = (e: ReturnType<typeof ev>, from: string, to: string) => ruleDates(e, from, to);
const lunarOf = (d: string) => solarToLunar(+d.slice(0, 4), +d.slice(5, 7), +d.slice(8, 10));
const sol = (d: number, m: number, y: number, leap = false) => {
  const s = lunarToSolar(d, m, y, leap)!;
  return `${s.y}-${String(s.m).padStart(2, '0')}-${String(s.d).padStart(2, '0')}`;
};

describe('lặp dương lịch', () => {
  it('không lặp: đúng một lần', () => {
    expect(days(ev({ start_local: '2026-10-14T14:00' }), '2026-10-01', '2026-10-31')).toEqual(['2026-10-14']);
  });
  it('mỗi ngày, mỗi 3 ngày, mỗi tuần, đến ngày (bao gồm)', () => {
    expect(days(ev({ start_local: '2026-10-09T07:00', repeat_unit: 'day', repeat_until: '2026-10-12' }), '2026-10-01', '2026-12-31')).toEqual(['2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12']);
    expect(days(ev({ start_local: '2026-10-09T07:00', repeat_unit: 'day', repeat_every: 3 }), '2026-10-09', '2026-10-20')).toEqual(['2026-10-09', '2026-10-12', '2026-10-15', '2026-10-18']);
    expect(days(ev({ start_local: '2026-10-05T09:00', repeat_unit: 'week' }), '2026-10-01', '2026-10-27')).toEqual(['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26']);
  });
  it('cửa sổ xa ngày bắt đầu vẫn đúng nhịp', () => {
    expect(days(ev({ start_local: '2026-01-01T07:00', repeat_unit: 'day', repeat_every: 7 }), '2026-10-01', '2026-10-15')).toEqual(['2026-10-01', '2026-10-08', '2026-10-15']);
  });
  it('mỗi tháng ngày 31 → ngày cuối tháng ở tháng ngắn, không trôi', () => {
    expect(days(ev({ start_local: '2026-01-31T09:00', repeat_unit: 'month' }), '2026-01-01', '2026-06-30')).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30']);
    expect(days(ev({ start_local: '2026-01-29T09:00', repeat_unit: 'month' }), '2028-02-01', '2028-02-29')).toEqual(['2028-02-29']);
  });
  it('mỗi năm 29/2 → 28/2 năm thường', () => {
    expect(days(ev({ start_local: '2024-02-29T09:00', repeat_unit: 'year' }), '2024-01-01', '2028-12-31')).toEqual(['2024-02-29', '2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29']);
  });
  it('mỗi 2 tháng', () => {
    expect(days(ev({ start_local: '2026-01-15T09:00', repeat_unit: 'month', repeat_every: 2 }), '2026-01-01', '2026-07-31')).toEqual(['2026-01-15', '2026-03-15', '2026-05-15', '2026-07-15']);
  });
});

describe('lặp âm lịch (AC-5)', () => {
  it('giỗ 12/3 âm hằng năm: đúng ngày dương mỗi năm 2026–2030', () => {
    const e = ev({ all_day: 1, start_local: sol(12, 3, 2026), repeat_unit: 'year', repeat_cal: 'lunar', lunar_month: 3, lunar_day: 12 });
    expect(days(e, '2026-01-01', '2030-12-31')).toEqual([2026, 2027, 2028, 2029, 2030].map((y) => sol(12, 3, y)));
  });
  it('rằm hằng tháng: 15 âm mỗi trăng, gồm tháng nhuận (năm 2025 nhuận 6 → 13 lần)', () => {
    const e = ev({ all_day: 1, start_local: sol(15, 1, 2025), repeat_unit: 'month', repeat_cal: 'lunar', lunar_month: 1, lunar_day: 15 });
    const got = days(e, '2025-01-01', '2026-02-10');
    expect(got.filter((d) => lunarOf(d).year === 2025)).toHaveLength(13);
    for (const d of got) expect(lunarOf(d).day).toBe(15);
    expect(got.some((d) => lunarOf(d).leap)).toBe(true);
  });
  it('đặt trong tháng nhuận (6 nhuận 2025) → các năm sau nhắc tháng thường cùng ngày, mỗi năm một lần', () => {
    const start = sol(10, 6, 2025, true);
    const e = ev({ all_day: 1, start_local: start, repeat_unit: 'year', repeat_cal: 'lunar', lunar_month: 6, lunar_day: 10 });
    const got = days(e, '2025-01-01', '2029-12-31');
    expect(got[0]).toBe(start); // lần đầu là chính ngày đặt
    const rest = got.slice(1).map(lunarOf);
    expect(rest.map((l) => l.year)).toEqual([2026, 2027, 2028, 2029]);
    for (const l of rest) expect(l).toMatchObject({ month: 6, day: 10, leap: false });
  });
  it('ngày 30 âm gặp tháng 29 ngày → ngày 29', () => {
    let m = 1;
    for (; m <= 12; m++) if (!lunarToSolar(30, m, 2026)) break;
    expect(m).toBeLessThanOrEqual(12);
    const e = ev({ all_day: 1, start_local: sol(1, m, 2026), repeat_unit: 'year', repeat_cal: 'lunar', lunar_month: m, lunar_day: 30 });
    expect(days(e, '2026-01-01', '2026-12-31')).toContain(sol(29, m, 2026));
  });
  it('ngoài phạm vi 1901–2099 không treo và không sinh gì', () => {
    const e = ev({ all_day: 1, start_local: '2150-01-01', repeat_unit: 'year', repeat_cal: 'lunar', lunar_month: 1, lunar_day: 1 });
    expect(days(e, '2150-01-01', '2152-01-01')).toEqual([]);
  });
});

describe('occurrences(): ngoại lệ "chỉ lần này"', () => {
  const daily = ev({ kind: 'reminder', title: 'Uống thuốc', start_local: '2026-10-09T07:00', repeat_unit: 'day' });
  const brief = (os: ReturnType<typeof occurrences>) => os.map((o) => `${o.occDate} ${o.startLocal.slice(11)} ${o.title}`);
  it('edit đổi giờ một lần, skip bỏ một lần, các lần khác nguyên', () => {
    const os = occurrences(daily, [ov(daily.id, '2026-10-10', 'edit', { start_local: '2026-10-10T08:00' }), ov(daily.id, '2026-10-11', 'skip')], '2026-10-09', '2026-10-12', env);
    expect(brief(os)).toEqual(['2026-10-09 07:00 Uống thuốc', '2026-10-10 08:00 Uống thuốc', '2026-10-12 07:00 Uống thuốc']);
    expect(os[1].edited).toBe(true);
  });
  it('đổi "tất cả" không xoá ngoại lệ cũ (ngoại lệ vẫn đè)', () => {
    const changed = { ...daily, start_local: '2026-10-09T06:30' };
    const os = occurrences(changed, [ov(daily.id, '2026-10-10', 'edit', { start_local: '2026-10-10T08:00' })], '2026-10-09', '2026-10-10', env);
    expect(os.map((o) => o.startLocal.slice(11))).toEqual(['06:30', '08:00']);
  });
  it('xong một lần: các lần khác chưa xong', () => {
    const os = occurrences(daily, [ov(daily.id, '2026-10-09', 'done', { at_ms: 1 })], '2026-10-09', '2026-10-10', env);
    expect(os.map((o) => o.done)).toEqual([true, false]);
  });
  it('hai máy cùng tạo ngoại lệ trùng: skip thắng; cùng loại → id nhỏ nhất, kết quả không phụ thuộc thứ tự', () => {
    const a = ov(daily.id, '2026-10-10', 'edit', { title: 'A' }, 'a');
    const b = ov(daily.id, '2026-10-10', 'edit', { title: 'B' }, 'b');
    expect(occurrences(daily, [a, b], '2026-10-10', '2026-10-10', env)[0].title).toBe('A');
    expect(occurrences(daily, [b, a], '2026-10-10', '2026-10-10', env)[0].title).toBe('A');
    expect(occurrences(daily, [a, ov(daily.id, '2026-10-10', 'skip', {}, 'z')], '2026-10-10', '2026-10-10', env)).toHaveLength(0);
  });
  it('mục không lặp: done_at_ms là xong; hoãn là snooze', () => {
    const one = ev({ kind: 'reminder', start_local: '2026-10-09T17:30', done_at_ms: 5 });
    expect(occurrences(one, [], '2026-10-09', '2026-10-09', env)[0].done).toBe(true);
    const sn = ev({ kind: 'reminder', start_local: '2026-10-09T17:30' });
    const o = occurrences(sn, [ov(sn.id, '2026-10-09', 'snooze', { until_local: '2026-10-09T18:30' })], '2026-10-09', '2026-10-09', env)[0];
    expect(o.snoozeUntilMs).toBe(VN.localToMs('2026-10-09T18:30'));
  });
  it('ngoại lệ của mục khác bị bỏ qua', () => {
    expect(occurrences(daily, [ov('khac', '2026-10-10', 'skip')], '2026-10-10', '2026-10-10', env)).toHaveLength(1);
  });
  it('lần bị dời từ ngoài cửa sổ vào trong cửa sổ vẫn hiện', () => {
    const w = ev({ start_local: '2026-10-01T09:00', repeat_unit: 'week' });
    const os = occurrences(w, [ov(w.id, '2026-10-01', 'edit', { start_local: '2026-10-20T09:00' })], '2026-10-19', '2026-10-21', env);
    expect(os.map((o) => o.occDate)).toEqual(['2026-10-01']);
    expect(os[0].dateLocal).toBe('2026-10-20');
  });
});

describe('giờ treo vs giờ cố định (AC-2)', () => {
  it('giờ treo: đổi múi giờ máy +7 → +9 vẫn 07:00 giờ mới', () => {
    const r = ev({ kind: 'reminder', start_local: '2026-10-10T07:00' });
    const a = occurrences(r, [], '2026-10-10', '2026-10-10', envAt('2026-10-09T08:00', VN))[0];
    const b = occurrences(r, [], '2026-10-10', '2026-10-10', envAt('2026-10-09T08:00', JP))[0];
    expect(VN.msToLocal(a.startMs).slice(11)).toBe('07:00');
    expect(JP.msToLocal(b.startMs).slice(11)).toBe('07:00');
    expect(a.startMs - b.startMs).toBe(2 * 3600_000);
  });
  it('giờ cố định: cùng thời điểm tuyệt đối, hiển thị theo giờ máy (09:00 Hà Nội = 11:00 ở +9)', () => {
    const m = ev({ title: 'Họp', start_local: '2026-10-12T09:00', fixed: 1, tz: 'Asia/Ho_Chi_Minh', repeat_unit: 'week' });
    const a = occurrences(m, [], '2026-10-12', '2026-10-12', envAt('2026-10-09T08:00', VN))[0];
    const b = occurrences(m, [], '2026-10-12', '2026-10-12', envAt('2026-10-09T08:00', JP))[0];
    expect(a.startMs).toBe(b.startMs);
    expect(VN.msToLocal(a.startMs)).toBe('2026-10-12T09:00');
    expect(JP.msToLocal(b.startMs)).toBe('2026-10-12T11:00');
  });
});

describe('tóm tắt lặp', () => {
  it('chữ tiếng Việt', () => {
    expect(repeatSummary(ev({ start_local: '2026-01-01T09:00' }))).toBe('Không lặp');
    expect(repeatSummary(ev({ start_local: '2026-01-01', repeat_unit: 'year', repeat_cal: 'lunar', lunar_month: 3, lunar_day: 12 }))).toBe('Mỗi năm vào 12/3 âm lịch');
    expect(repeatSummary(ev({ start_local: '2026-01-01', repeat_unit: 'week', repeat_every: 2, repeat_until: '2026-12-31' }))).toBe('Mỗi 2 tuần, đến 31/12/2026');
  });
});
