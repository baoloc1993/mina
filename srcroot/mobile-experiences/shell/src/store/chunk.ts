// Chia lô upload ≤ 100 thay đổi (AC-10; DECISIONS vòng 2: MAX_OPS của `upload` = 100).
export const UPLOAD_BATCH = 100;

export function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}
