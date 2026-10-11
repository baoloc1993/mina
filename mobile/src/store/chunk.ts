// Chia lô upload ≤ 100 thay đổi.
export const UPLOAD_BATCH = 100;

export function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}
