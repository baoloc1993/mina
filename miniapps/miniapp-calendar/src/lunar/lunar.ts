// Âm–dương lịch Việt Nam (múi giờ cố định UTC+7), tự hiện thực — KHÔNG dùng thư viện ngoài.
// Thuật toán thiên văn (điểm sóc + kinh độ Mặt Trời) theo Hồ Ngọc Đức; phạm vi hỗ trợ 1901–2099.
// Thuần: không đụng DOM, không Date theo múi giờ máy — vào/ra là bộ (năm, tháng, ngày) dương lịch Gregorian.
// Lịch Việt Nam +7 khác lịch Trung Quốc +8 ở vài năm (1985, 1997, 2007…) nên không dùng được gói lịch Trung Quốc.

const PI = Math.PI;
const TZ = 7;
const SYNODIC = 29.530588853;
const EPOCH = 2415021.076998695;

export const MIN_YEAR = 1901;
export const MAX_YEAR = 2099;

const INT = Math.floor;

/** Ngày Julian (số nguyên) của ngày dương lịch. */
export function jdFromDate(dd: number, mm: number, yy: number): number {
  const a = INT((14 - mm) / 12);
  const y = yy + 4800 - a;
  const m = mm + 12 * a - 3;
  let jd = dd + INT((153 * m + 2) / 5) + 365 * y + INT(y / 4) - INT(y / 100) + INT(y / 400) - 32045;
  if (jd < 2299161) jd = dd + INT((153 * m + 2) / 5) + 365 * y + INT(y / 4) - 32083;
  return jd;
}

export function jdToDate(jd: number): { d: number; m: number; y: number } {
  let b: number;
  let c: number;
  if (jd > 2299160) {
    const a = jd + 32044;
    b = INT((4 * a + 3) / 146097);
    c = a - INT((b * 146097) / 4);
  } else {
    b = 0;
    c = jd + 32082;
  }
  const d = INT((4 * c + 3) / 1461);
  const e = c - INT((1461 * d) / 4);
  const m = INT((5 * e + 2) / 153);
  return { d: e - INT((153 * m + 2) / 5) + 1, m: m + 3 - 12 * INT(m / 10), y: b * 100 + d - 4800 + INT(m / 10) };
}

/** Ngày Julian (nguyên, theo giờ địa phương +7) của lần sóc thứ k tính từ 1900-01-01. */
function newMoonDay(k: number): number {
  const T = k / 1236.85;
  const T2 = T * T;
  const T3 = T2 * T;
  const dr = PI / 180;
  let Jd1 = 2415020.75933 + SYNODIC * k + 0.0001178 * T2 - 0.000000155 * T3;
  Jd1 += 0.00033 * Math.sin((166.56 + 132.87 * T - 0.009173 * T2) * dr);
  const M = 359.2242 + 29.10535608 * k - 0.0000333 * T2 - 0.00000347 * T3;
  const Mpr = 306.0253 + 385.81691806 * k + 0.0107306 * T2 + 0.00001236 * T3;
  const F = 21.2964 + 390.67050646 * k - 0.0016528 * T2 - 0.00000239 * T3;
  let C1 = (0.1734 - 0.000393 * T) * Math.sin(M * dr) + 0.0021 * Math.sin(2 * dr * M);
  C1 += -0.4068 * Math.sin(Mpr * dr) + 0.0161 * Math.sin(dr * 2 * Mpr);
  C1 -= 0.0004 * Math.sin(dr * 3 * Mpr);
  C1 += 0.0104 * Math.sin(dr * 2 * F) - 0.0051 * Math.sin(dr * (M + Mpr));
  C1 += -0.0074 * Math.sin(dr * (M - Mpr)) + 0.0004 * Math.sin(dr * (2 * F + M));
  C1 += -0.0004 * Math.sin(dr * (2 * F - M)) - 0.0006 * Math.sin(dr * (2 * F + Mpr));
  C1 += 0.001 * Math.sin(dr * (2 * F - Mpr)) + 0.0005 * Math.sin(dr * (2 * Mpr + M));
  const deltat = T < -11 ? 0.001 + 0.000839 * T + 0.0002261 * T2 - 0.00000845 * T3 - 0.000000081 * T * T3 : -0.000278 + 0.000265 * T + 0.000262 * T2;
  return INT(Jd1 + C1 - deltat + 0.5 + TZ / 24);
}

/** Cung (0..11) của kinh độ Mặt Trời tại nửa đêm địa phương của ngày Julian `jdn`. */
function sunLongitude(jdn: number): number {
  const T = (jdn - 2451545.5 - TZ / 24) / 36525;
  const T2 = T * T;
  const dr = PI / 180;
  const M = 357.5291 + 35999.0503 * T - 0.0001559 * T2 - 0.00000048 * T * T2;
  const L0 = 280.46645 + 36000.76983 * T + 0.0003032 * T2;
  let DL = (1.9146 - 0.004817 * T - 0.000014 * T2) * Math.sin(dr * M);
  DL += (0.019993 - 0.000101 * T) * Math.sin(dr * 2 * M) + 0.00029 * Math.sin(dr * 3 * M);
  let L = (L0 + DL) * dr;
  L -= PI * 2 * INT(L / (PI * 2));
  return INT((L / PI) * 6);
}

// Bộ nhớ đệm theo năm: ngày sóc của tháng 11 âm và vị trí tháng nhuận được hỏi lặp đi lặp lại khi vẽ lưới.
const m11Cache = new Map<number, number>();
const leapCache = new Map<number, number>();

/** Ngày Julian bắt đầu tháng 11 âm lịch (tháng chứa Đông chí) của năm dương `yy`. */
function lunarMonth11(yy: number): number {
  const hit = m11Cache.get(yy);
  if (hit !== undefined) return hit;
  const off = jdFromDate(31, 12, yy) - 2415021;
  const k = INT(off / SYNODIC);
  let nm = newMoonDay(k);
  if (sunLongitude(nm) >= 9) nm = newMoonDay(k - 1);
  m11Cache.set(yy, nm);
  return nm;
}

/** Vị trí (độ lệch tháng so với tháng 11) của tháng nhuận trong năm âm bắt đầu từ tháng 11 `a11`. */
function leapMonthOffset(a11: number): number {
  const hit = leapCache.get(a11);
  if (hit !== undefined) return hit;
  const k = INT((a11 - EPOCH) / SYNODIC + 0.5);
  let i = 1;
  let arc = sunLongitude(newMoonDay(k + i));
  let last: number;
  do {
    last = arc;
    i++;
    arc = sunLongitude(newMoonDay(k + i));
  } while (arc !== last && i < 14);
  leapCache.set(a11, i - 1);
  return i - 1;
}

export interface LunarDate {
  day: number;
  month: number;
  year: number;
  /** Tháng nhuận (cùng số với tháng thường đứng trước). */
  leap: boolean;
}

export interface SolarDate {
  y: number;
  m: number;
  d: number;
}

export function solarToLunar(y: number, m: number, d: number): LunarDate {
  const dayNumber = jdFromDate(d, m, y);
  const k = INT((dayNumber - EPOCH) / SYNODIC);
  let monthStart = newMoonDay(k + 1);
  if (monthStart > dayNumber) monthStart = newMoonDay(k);
  let a11 = lunarMonth11(y);
  let b11 = a11;
  let lunarYear: number;
  if (a11 >= monthStart) {
    lunarYear = y;
    a11 = lunarMonth11(y - 1);
  } else {
    lunarYear = y + 1;
    b11 = lunarMonth11(y + 1);
  }
  const day = dayNumber - monthStart + 1;
  const diff = INT((monthStart - a11) / 29);
  let leap = false;
  let month = diff + 11;
  if (b11 - a11 > 365) {
    const leapDiff = leapMonthOffset(a11);
    if (diff >= leapDiff) {
      month = diff + 10;
      if (diff === leapDiff) leap = true;
    }
  }
  if (month > 12) month -= 12;
  if (month >= 11 && diff < 4) lunarYear -= 1;
  return { day, month, year: lunarYear, leap };
}

/** Đổi ngày âm → dương. Trả `null` khi tháng nhuận không tồn tại hoặc ngày không có trong tháng (vd 30 của tháng thiếu). */
export function lunarToSolar(day: number, month: number, year: number, leap = false): SolarDate | null {
  let a11: number;
  let b11: number;
  if (month < 11) {
    a11 = lunarMonth11(year - 1);
    b11 = lunarMonth11(year);
  } else {
    a11 = lunarMonth11(year);
    b11 = lunarMonth11(year + 1);
  }
  const k = INT(0.5 + (a11 - EPOCH) / SYNODIC);
  let off = month - 11;
  if (off < 0) off += 12;
  if (b11 - a11 > 365) {
    const leapOff = leapMonthOffset(a11);
    let leapMonth = leapOff - 2;
    if (leapMonth < 0) leapMonth += 12;
    if (leap && month !== leapMonth) return null;
    if (leap || off >= leapOff) off += 1;
  } else if (leap) {
    return null;
  }
  const start = newMoonDay(k + off);
  const next = newMoonDay(k + off + 1);
  if (day < 1 || day > next - start) return null;
  const r = jdToDate(start + day - 1);
  return { y: r.y, m: r.m, d: r.d };
}

/** Số tháng nhuận (1..12) trong khoảng từ tháng 11 của năm dương `y` tới tháng 11 năm sau; 0 nếu khoảng đó không có nhuận. */
function leapInSpan(y: number): number {
  const a11 = lunarMonth11(y);
  if (lunarMonth11(y + 1) - a11 <= 365) return 0;
  let m = leapMonthOffset(a11) - 2;
  if (m < 0) m += 12;
  return m;
}

/**
 * Số tháng nhuận của năm âm `year` (1..12), 0 nếu không nhuận. Năm âm `year` gồm tháng 1..10 nằm trong khoảng [11/year-1, 11/year) và
 * tháng 11, 12 nằm trong [11/year, 11/year+1) — nên nhuận 1..10 lấy ở khoảng trước, nhuận 11 / 12 lấy ở khoảng sau (vd 2033: nhuận 11).
 */
export function leapMonthOf(year: number): number {
  const before = leapInSpan(year - 1);
  if (before >= 1 && before <= 10) return before;
  const after = leapInSpan(year);
  return after >= 11 ? after : 0;
}

/** Số ngày (29 hoặc 30) của một tháng âm lịch. `null` nếu tháng nhuận không tồn tại. */
export function lunarMonthLength(month: number, year: number, leap = false): number | null {
  const first = lunarToSolar(1, month, year, leap);
  if (!first) return null;
  return lunarToSolar(30, month, year, leap) ? 30 : 29;
}

/** Tháng âm kế tiếp (tính cả tháng nhuận). */
export function nextLunarMonth(month: number, year: number, leap: boolean): { month: number; year: number; leap: boolean } {
  if (!leap && leapMonthOf(year) === month) return { month, year, leap: true };
  if (month === 12) return { month: 1, year: year + 1, leap: false };
  return { month: month + 1, year, leap: false };
}

export function inRange(y: number): boolean {
  return y >= MIN_YEAR && y <= MAX_YEAR;
}

/** Nhãn ngắn dưới số dương trên lưới: "15" hoặc, mùng 1, "1/9" (kèm "nhuận" nếu nhuận). */
export function lunarLabel(l: LunarDate): string {
  if (l.day === 1) return `1/${l.month}${l.leap ? 'N' : ''}`;
  return String(l.day);
}

/** "15/8 âm lịch" · "1/6 nhuận". */
export function lunarText(l: LunarDate): string {
  return `${l.day}/${l.month}${l.leap ? ' nhuận' : ''} âm lịch`;
}
