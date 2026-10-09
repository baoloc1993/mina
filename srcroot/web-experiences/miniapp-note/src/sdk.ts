// Kiểu và lối vào duy nhất tới nền tảng: `window.miniapp` do shell tiêm vào (SDK 0.1.1). Mini app KHÔNG dùng fetch / localStorage /
// IndexedDB trực tiếp (PRD §5) — mọi dữ liệu đi qua SDK. Kiểu lấy từ d.ts của SDK (chỉ kiểu, không có mã chạy).
export type Sdk = Window['miniapp'];

export function getSdk(): Sdk {
  return window.miniapp;
}

/** UUID v4 phía client (luật chung: id do client sinh — hai máy offline không được trùng). */
export function newId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Mã lỗi SDK (`error.code`) hoặc chuỗi rỗng. */
export function errCode(e: unknown): string {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' ? c : '';
}
