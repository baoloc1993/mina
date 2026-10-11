// Định dạng thời gian / số cho chữ hiện ra người dùng (tiếng Việt). Thuần TS.

const two = (n: number): string => String(n).padStart(2, '0');

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "hôm nay 10:41" · "hôm qua 10:41" · "08/10 10:41" · "08/10/2025 10:41" (khác năm). */
export function formatWhen(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return 'chưa lần nào';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return 'không rõ';
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
  if (sameDay(d, now)) return `hôm nay ${hm}`;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return `hôm qua ${hm}`;
  const dm = `${two(d.getDate())}/${two(d.getMonth() + 1)}`;
  return d.getFullYear() === now.getFullYear() ? `${dm} ${hm}` : `${dm}/${d.getFullYear()} ${hm}`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  return `${two(d.getDate())}/${two(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/** Ân hạn còn lại → "còn 5 ngày" / "còn 3 giờ" / "còn dưới 1 giờ". */
export function formatGraceLeft(ms: number): string {
  const day = 86_400_000;
  const hour = 3_600_000;
  if (ms >= day) return `còn ${Math.ceil(ms / day)} ngày`;
  if (ms >= hour) return `còn ${Math.ceil(ms / hour)} giờ`;
  return 'còn dưới 1 giờ';
}

export function pendingText(n: number): string {
  return n === 0 ? 'Không có thay đổi nào đang chờ gửi' : `${n} thay đổi đang chờ gửi`;
}
