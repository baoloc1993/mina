// Kiểm đầu vào thuần của Edge Functions (vòng 7, dogfood breaker): tách file để test không cần runtime.

/** `app_id` của issue-app-token: PHẢI là chuỗi (mảng/số/object từng lọt qua regex ngầm và đi vào claim JWT) dạng reverse-domain. */
export function parseAppId(v: unknown): string | null {
  return typeof v === "string" && v.length <= 64 && /^[a-z0-9]+(\.[a-z0-9-]+)+$/.test(v) ? v : null;
}

/** Body JSON của issue-app-token: object (không null/mảng/số). */
export function asObject(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Trần kích thước body của `upload` (byte). Lô hợp lệ ≤ 100 thay đổi, mỗi dòng nhỏ: 2 MB là dư. */
export const MAX_UPLOAD_BYTES = 2_000_000;

/** `data` của dòng bị từ chối chỉ giữ nhỏ (bảng `sync_rejections` không phải kho chứa body người dùng). */
export function clipRejectionData(data: unknown, maxChars = 4000): unknown {
  if (data === undefined || data === null) return data ?? null;
  let s: string;
  try {
    s = JSON.stringify(data);
  } catch {
    return { _clipped: true };
  }
  return s.length <= maxChars ? data : { _clipped: true, chars: s.length, head: s.slice(0, 200) };
}

/**
 * Đọc body dạng chữ NHƯNG dừng ngay khi vượt `max` BYTE (kể cả khi client gửi chunked, không có Content-Length) — `req.text()` sẽ đọc hết
 * vào RAM rồi mới so (reviewer vòng 7). Trả `null` khi vượt trần (nên trả 413).
 */
export async function readTextLimited(body: ReadableStream<Uint8Array> | null, max: number): Promise<string | null> {
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(all);
}
