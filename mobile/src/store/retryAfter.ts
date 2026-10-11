// Giãn cách khi server trả 429 RATE_LIMITED (vòng 7): đợi `Retry-After` / `retry_after_s`, kẹp trong [5 s, 60 s] — không thử dồn
// (mỗi lần thử bị từ chối vẫn tính vào trần nên máy bị chặn sẽ tự duy trì trạng thái bị chặn).
export const MIN_BACKOFF_MS = 5_000;
export const MAX_BACKOFF_MS = 60_000;

export function rateLimitDelayMs(headerValue: string | null | undefined, bodyRetryAfterS?: unknown): number {
  const fromHeader = Number(headerValue);
  const fromBody = Number(bodyRetryAfterS);
  const s = Number.isFinite(fromHeader) && fromHeader > 0 ? fromHeader : Number.isFinite(fromBody) && fromBody > 0 ? fromBody : 0;
  return Math.min(MAX_BACKOFF_MS, Math.max(MIN_BACKOFF_MS, Math.round(s * 1000)));
}
