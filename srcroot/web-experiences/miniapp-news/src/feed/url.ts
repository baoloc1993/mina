// Chuẩn hoá địa chỉ nguồn người dùng dán (ARCHITECTURE.md §6 "Thêm nguồn"): chỉ http(s), bỏ #, không user:pass@, host đúng khuôn
// mà `net.requestAccess` nhận (chữ thường, không wildcard, cổng tuỳ chọn).
export const MAX_URL = 2048;
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;

export type UrlCheck = { ok: true; url: string; host: string } | { ok: false; message: string };

export function normalizeFeedUrl(raw: string): UrlCheck {
  const t = (raw ?? '').trim();
  if (!t) return { ok: false, message: 'Dán địa chỉ RSS hoặc Atom của nguồn' };
  if (/\s/.test(t)) return { ok: false, message: 'Địa chỉ không được có khoảng trắng' };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return { ok: false, message: 'Địa chỉ không hợp lệ — ví dụ https://blog.example.dev/rss' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, message: 'Chỉ nhận địa chỉ http hoặc https' };
  if (u.username || u.password) return { ok: false, message: 'Địa chỉ không được chứa tên đăng nhập hoặc mật khẩu' };
  u.hash = '';
  const url = u.toString();
  if (url.length > MAX_URL) return { ok: false, message: 'Địa chỉ quá dài (tối đa 2048 ký tự)' };
  const host = u.host.toLowerCase();
  if (!HOST_RE.test(host) || host.length > 253) return { ok: false, message: 'Tên miền không hợp lệ' };
  return { ok: true, url, host };
}

/** URL http(s) an toàn để mở / lưu (≤ 2048, không user:pass@); khác → null. */
export function safeHttpUrl(raw: string | null | undefined): string | null {
  const t = (raw ?? '').trim();
  if (!t || t.length > MAX_URL) return null;
  try {
    const u = new URL(t);
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) return null;
    return u.toString().length > MAX_URL ? null : u.toString();
  } catch {
    return null;
  }
}
