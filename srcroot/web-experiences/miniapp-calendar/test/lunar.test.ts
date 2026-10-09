// Bảng đối chiếu âm lịch Việt Nam (+7) — AC-5. Mốc đã biết: Tết Nguyên Đán, Giỗ Tổ (10/3), Trung Thu (15/8), tháng nhuận.
import { describe, expect, it } from 'vitest';
import { jdFromDate, jdToDate, leapMonthOf, lunarMonthLength, lunarToSolar, nextLunarMonth, solarToLunar } from '../src/lunar/lunar';

const iso = (s: { y: number; m: number; d: number } | null) => (s ? `${s.y}-${String(s.m).padStart(2, '0')}-${String(s.d).padStart(2, '0')}` : null);

// 2030: lần sóc rơi 23:0x giờ Việt Nam (+7) ngày 02/02 nhưng đã sang 03/02 theo giờ Bắc Kinh (+8) — Tết VN 02/02, Tết TQ 03/02.
// Chính là lý do không dùng gói lịch Trung Quốc (DECISIONS vòng 5).
describe('Tết Nguyên Đán 2020–2035 (1/1 âm → dương)', () => {
  const TET: Record<number, string> = {
    2020: '2020-01-25', 2021: '2021-02-12', 2022: '2022-02-01', 2023: '2023-01-22', 2024: '2024-02-10', 2025: '2025-01-29',
    2026: '2026-02-17', 2027: '2027-02-06', 2028: '2028-01-26', 2029: '2029-02-13', 2030: '2030-02-02', 2031: '2031-01-23',
    2032: '2032-02-11', 2033: '2033-01-31', 2034: '2034-02-19', 2035: '2035-02-08',
  };
  for (const [y, d] of Object.entries(TET)) {
    it(`năm ${y}`, () => {
      expect(iso(lunarToSolar(1, 1, Number(y)))).toBe(d);
      const [yy, mm, dd] = d.split('-').map(Number);
      expect(solarToLunar(yy, mm, dd)).toEqual({ day: 1, month: 1, year: Number(y), leap: false });
    });
  }
});

describe('mốc ngày lễ âm lịch', () => {
  it('Rằm tháng Giêng 2024 = 24/02', () => expect(iso(lunarToSolar(15, 1, 2024))).toBe('2024-02-24'));
  it('Giỗ Tổ Hùng Vương (10/3) 2023–2026', () => {
    expect(iso(lunarToSolar(10, 3, 2023))).toBe('2023-04-29');
    expect(iso(lunarToSolar(10, 3, 2024))).toBe('2024-04-18');
    expect(iso(lunarToSolar(10, 3, 2025))).toBe('2025-04-07');
    expect(iso(lunarToSolar(10, 3, 2026))).toBe('2026-04-26');
  });
  it('Trung Thu (15/8) 2023–2026', () => {
    expect(iso(lunarToSolar(15, 8, 2023))).toBe('2023-09-29');
    expect(iso(lunarToSolar(15, 8, 2024))).toBe('2024-09-17');
    expect(iso(lunarToSolar(15, 8, 2025))).toBe('2025-10-06');
    expect(iso(lunarToSolar(15, 8, 2026))).toBe('2026-09-25');
  });
  it('hôm nay 09/10/2026 = 29/8 (tháng 8 thiếu); 1/9 = 10/10', () => {
    expect(solarToLunar(2026, 10, 9)).toMatchObject({ day: 29, month: 8, year: 2026, leap: false });
    expect(iso(lunarToSolar(1, 9, 2026))).toBe('2026-10-10');
    expect(iso(lunarToSolar(1, 8, 2026))).toBe('2026-09-11');
  });
});

describe('tháng nhuận', () => {
  it('2020 nhuận tháng 4, 2023 nhuận tháng 2, 2025 nhuận tháng 6, 2028 nhuận tháng 5, 2031 nhuận tháng 3', () => {
    expect(leapMonthOf(2020)).toBe(4);
    expect(leapMonthOf(2023)).toBe(2);
    expect(leapMonthOf(2025)).toBe(6);
    expect(leapMonthOf(2028)).toBe(5);
    expect(leapMonthOf(2031)).toBe(3);
  });
  it('2033 nhuận tháng 11 (nhuận 11 thuộc khoảng sau Đông chí) và vẫn đủ 13 tháng', () => {
    expect(leapMonthOf(2033)).toBe(11);
    expect(leapMonthOf(2034)).toBe(0);
    const l = lunarToSolar(1, 11, 2033, true);
    expect(l).not.toBeNull();
    expect(solarToLunar(l!.y, l!.m, l!.d)).toEqual({ day: 1, month: 11, year: 2033, leap: true });
  });
  it('năm không nhuận → 0', () => {
    for (const y of [2021, 2022, 2024, 2026, 2027]) expect(leapMonthOf(y)).toBe(0);
  });
  it('2025: 1/6 nhuận tồn tại, 1/5 nhuận thì không', () => {
    const leap = lunarToSolar(1, 6, 2025, true);
    expect(leap).not.toBeNull();
    expect(solarToLunar(leap!.y, leap!.m, leap!.d)).toEqual({ day: 1, month: 6, year: 2025, leap: true });
    expect(lunarToSolar(1, 5, 2025, true)).toBeNull();
    expect(lunarToSolar(1, 6, 2026, true)).toBeNull();
  });
  it('tháng nhuận nằm ngay sau tháng thường cùng số', () => {
    expect(nextLunarMonth(6, 2025, false)).toEqual({ month: 6, year: 2025, leap: true });
    expect(nextLunarMonth(6, 2025, true)).toEqual({ month: 7, year: 2025, leap: false });
    expect(nextLunarMonth(12, 2025, false)).toEqual({ month: 1, year: 2026, leap: false });
  });
});

describe('tính nhất quán 1901–2099', () => {
  it('chuyển đổi hai chiều khớp cho từng ngày (mẫu mỗi 7 ngày) và độ dài tháng 29/30', () => {
    let jd = jdFromDate(1, 2, 1901);
    const end = jdFromDate(31, 12, 2098);
    let n = 0;
    for (; jd < end; jd += 7) {
      const s = jdToDate(jd);
      const l = solarToLunar(s.y, s.m, s.d);
      expect(l.day).toBeGreaterThanOrEqual(1);
      expect(l.day).toBeLessThanOrEqual(30);
      const back = lunarToSolar(l.day, l.month, l.year, l.leap);
      expect(iso(back)).toBe(iso({ y: s.y, m: s.m, d: s.d }));
      n++;
    }
    expect(n).toBeGreaterThan(5000);
  });

  it('mỗi năm âm 12 hoặc 13 tháng, dài 353–355 hoặc 383–385 ngày; Tết rơi 21/1–21/2', () => {
    for (let y = 1902; y <= 2098; y++) {
      const tet = lunarToSolar(1, 1, y)!;
      const next = lunarToSolar(1, 1, y + 1)!;
      const len = jdFromDate(next.d, next.m, next.y) - jdFromDate(tet.d, tet.m, tet.y);
      const leap = leapMonthOf(y);
      expect(len === 353 || len === 354 || len === 355 || len === 383 || len === 384 || len === 385, `năm ${y}: ${len}`).toBe(true);
      expect(leap > 0).toBe(len > 360);
      const t = jdFromDate(tet.d, tet.m, tet.y);
      expect(t).toBeGreaterThanOrEqual(jdFromDate(21, 1, y));
      expect(t).toBeLessThanOrEqual(jdFromDate(21, 2, y));
    }
  });

  it('độ dài từng tháng 2024–2027 (29 hoặc 30) cộng đúng độ dài năm', () => {
    for (const y of [2024, 2025, 2026, 2027]) {
      let sum = 0;
      for (let m = 1; m <= 12; m++) {
        const a = lunarMonthLength(m, y)!;
        expect([29, 30]).toContain(a);
        sum += a;
        if (leapMonthOf(y) === m) sum += lunarMonthLength(m, y, true)!;
      }
      const tet = lunarToSolar(1, 1, y)!;
      const next = lunarToSolar(1, 1, y + 1)!;
      expect(sum).toBe(jdFromDate(next.d, next.m, next.y) - jdFromDate(tet.d, tet.m, tet.y));
    }
  });

  it('ngày 30 không tồn tại ở tháng 29 ngày', () => {
    let found = 0;
    for (let m = 1; m <= 12; m++) {
      if (lunarMonthLength(m, 2026) === 29) {
        expect(lunarToSolar(30, m, 2026)).toBeNull();
        found++;
      }
    }
    expect(found).toBeGreaterThan(0);
  });
});
