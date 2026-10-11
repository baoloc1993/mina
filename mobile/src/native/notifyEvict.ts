// Chọn thông báo cần bỏ (CAP-RT-05): mỗi app giữ ≤ `max` thông báo SẮP TỚI gần nhất; thông báo đã qua không tính vào
// giới hạn nhưng bị dọn khi cũ hơn `staleMs`. THUẦN TS.
export interface NotifyRow {
  id: string;
  at: number;
}

export function pickEvictions(rows: NotifyRow[], now: number, max = 50, staleMs = 86_400_000): { drop: string[] } {
  const drop: string[] = [];
  const upcoming: NotifyRow[] = [];
  for (const r of rows) {
    if (r.at > now) upcoming.push(r);
    else if (now - r.at > staleMs) drop.push(r.id);
  }
  upcoming.sort((a, b) => a.at - b.at);
  for (const r of upcoming.slice(max)) drop.push(r.id);
  return { drop };
}
