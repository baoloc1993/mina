import { describe, expect, test } from 'vitest';
import { joinDate, parseDate, parseTime } from '../src/ui/kit';

describe('ô chọn ngày/giờ bằng <select> (dogfood vòng 7: bộ chọn gốc không mở trên máy thật)', () => {
  test('parseDate / joinDate khứ hồi và chưa chọn → ""', () => {
    expect(parseDate('2026-10-10')).toEqual({ y: 2026, m: 10, d: 10 });
    expect(parseDate('')).toEqual({ y: 0, m: 0, d: 0 });
    expect(parseDate('10/10/2026')).toEqual({ y: 0, m: 0, d: 0 });
    expect(joinDate(2026, 10, 10)).toBe('2026-10-10');
    expect(joinDate(2026, 10, 0)).toBe('');
    expect(joinDate(0, 10, 10)).toBe('');
    expect(joinDate(2026, 0, 10)).toBe('');
  });
  test('ngày vượt số ngày của tháng được kẹp (31/02 → 28 hoặc 29)', () => {
    expect(joinDate(2026, 2, 31)).toBe('2026-02-28');
    expect(joinDate(2028, 2, 31)).toBe('2028-02-29');
    expect(joinDate(2026, 4, 31)).toBe('2026-04-30');
    expect(joinDate(2026, 12, 31)).toBe('2026-12-31');
  });
  test('parseTime chỉ nhận HH:mm', () => {
    expect(parseTime('20:05')).toEqual({ h: 20, n: 5 });
    expect(parseTime('')).toBeNull();
    expect(parseTime('8:5')).toBeNull();
  });
});
