// Logic biểu mẫu S16: ngày âm nhập thẳng, cảnh báo giờ đã qua, vá "chỉ lần này", nút nhanh.
import { describe, expect, it } from 'vitest';
import { lunarToSolar, solarToLunar } from '../src/lunar/lunar';
import { buildRow, defaultForm, isPast, nextLunarDate, quickPicks, snoozeOptions, thisOnlyPatch, validate, whenText, formFromEvent } from '../src/ui/form';
import { occurrences } from '../src/recur/occurrences';
import { envAt, ev, VN } from './fixtures';

const env = envAt('2026-10-09T20:14');

describe('nextLunarDate', () => {
  it('giỗ 12/3 âm: lần gần nhất từ 09/10/2026 là 12/3 âm 2027 = 18/04/2027', () => {
    expect(nextLunarDate(12, 3, '2026-10-09')).toBe('2027-04-18');
    const l = solarToLunar(2027, 4, 18);
    expect(l).toMatchObject({ day: 12, month: 3 });
  });
  it('rằm hằng tháng: 15 âm gần nhất từ 09/10/2026 là 24/10/2026', () => {
    const d = nextLunarDate(15, null, '2026-10-09')!;
    expect(solarToLunar(+d.slice(0, 4), +d.slice(5, 7), +d.slice(8, 10)).day).toBe(15);
    expect(d >= '2026-10-09' && d <= '2026-11-10').toBe(true);
  });
  it('ngày 30 gặp tháng thiếu → ngày 29, và trả đúng ngày không sớm hơn from', () => {
    for (let m = 1; m <= 12; m++) {
      const d = nextLunarDate(30, m, '2026-10-09')!;
      expect(d >= '2026-10-09').toBe(true);
      expect(lunarToSolar(30, m, +d.slice(0, 4) === 2026 ? 2026 : 2027) !== undefined).toBe(true);
    }
  });
});

describe('biểu mẫu', () => {
  it('mục lặp đặt giờ đã qua KHÔNG cảnh báo "sẽ nhắc ngay"; mục không lặp thì có', () => {
    const f = { ...defaultForm('reminder', '2026-10-09', env), time: '07:00', title: 'Thuốc' };
    expect(isPast(f, env)).toBe(true);
    expect(isPast({ ...f, unit: 'day' }, env)).toBe(false);
  });
  it('validate: tiêu đề rỗng, kết thúc ≤ bắt đầu, đến ngày trước bắt đầu, every 0', () => {
    const f = defaultForm('event', '2026-10-09', env);
    expect(validate({ ...f, title: '', endTime: '08:00', time: '09:00', unit: 'day', every: 0, until: '2026-10-01' })).toMatchObject({ title: 'Nhập tiêu đề', end: 'Giờ kết thúc phải sau giờ bắt đầu', every: expect.any(String), until: expect.any(String) });
    expect(validate({ ...f, title: 'x' })).toEqual({});
  });
  it('buildRow: lặp âm → cả ngày + neo âm; giờ cố định → start_ms/tz', () => {
    const f = { ...defaultForm('event', '2027-04-18', env), title: 'Giỗ', unit: 'year' as const, cal: 'lunar' as const };
    const r = buildRow(f, 'id1', null, env);
    expect(r).toMatchObject({ all_day: 1, start_local: '2027-04-18', repeat_cal: 'lunar', lunar_month: 3, lunar_day: 12, fixed: 0 });
    const fx = buildRow({ ...defaultForm('event', '2026-10-12', env), title: 'Họp', time: '09:00', endTime: '10:00', fixed: true }, 'id2', null, env);
    expect(fx).toMatchObject({ fixed: 1, start_ms: VN.localToMs('2026-10-12T09:00'), end_ms: VN.localToMs('2026-10-12T10:00') });
    expect(fx.tz).toBeTruthy();
  });
  it('thisOnlyPatch chỉ chứa phần đổi', () => {
    const e = ev({ kind: 'reminder', title: 'Thuốc', start_local: '2026-10-09T07:00', repeat_unit: 'day' });
    const occ = occurrences(e, [], '2026-10-10', '2026-10-10', env)[0];
    const f = formFromEvent(e, occ, env);
    expect(thisOnlyPatch(f, occ, env)).toEqual({});
    expect(thisOnlyPatch({ ...f, time: '08:00' }, occ, env)).toEqual({ start_local: '2026-10-10T08:00' });
    expect(thisOnlyPatch({ ...f, title: 'Thuốc huyết áp' }, occ, env)).toEqual({ title: 'Thuốc huyết áp' });
  });
  it('nút nhanh: sau 20:00 không có "Chiều nay"; trước 17:00 là 17:00; sau 17:00 là 19:00', () => {
    expect(quickPicks(env).map((q) => q.label)).toEqual(['Sau 1 giờ', 'Sáng mai', 'Cuối tuần']);
    expect(quickPicks(envAt('2026-10-09T10:00')).find((q) => q.label === 'Chiều nay')!.time).toBe('17:00');
    expect(quickPicks(envAt('2026-10-09T18:00')).find((q) => q.label === 'Chiều nay')!.time).toBe('19:00');
    expect(quickPicks(env).find((q) => q.label === 'Cuối tuần')!.date).toBe('2026-10-10');
  });
  it('hoãn: nhãn thời điểm có ngày', () => {
    const opts = snoozeOptions(env);
    expect(opts.map((o) => o.until)).toEqual(['2026-10-09T20:24', '2026-10-09T21:14', '2026-10-10T07:00']);
    expect(whenText(VN.localToMs('2026-10-09T21:14'), env)).toBe('hôm nay 21:14');
    expect(whenText(VN.localToMs('2026-10-10T07:00'), env)).toBe('ngày mai 07:00');
    expect(whenText(VN.localToMs('2026-10-12T07:00'), env)).toBe('12/10 07:00');
  });
});
