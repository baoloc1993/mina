// Whitelist cho sdk.net (CAP-RT-06, AC-8; mở rộng vòng 6): host phải khớp ĐÚNG một mục trong danh sách cho phép —
// không subdomain, không wildcard, chỉ http(s), không user:pass@. Danh sách = manifest.network ∪ config.network ∪ grant của người dùng
// (bridge ghép, xem `allowedHosts` ở bridge.ts). Dùng cho URL ban đầu lẫn mọi bước chuyển hướng.
// Khớp theo `URL.host` (có cổng nếu không phải cổng mặc định): mục `a.vn` khớp `https://a.vn` và `https://a.vn:443` nhưng KHÔNG khớp `a.vn:8080`;
// mục `10.0.2.2:8787` chỉ khớp đúng cổng đó.

/** Khuôn host của `network[]` / grant: chữ thường, không wildcard, không scheme/path/user:pass@, cổng tuỳ chọn. */
export const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;

export function isValidHost(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > 253) return false;
  if (!HOST_PATTERN.test(raw)) return false;
  const port = /:(\d+)$/.exec(raw)?.[1];
  return port === undefined || (Number(port) >= 1 && Number(port) <= 65535);
}

export function parseUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string' || raw.length > 4096) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

export function isAllowedUrl(raw: string, network: readonly string[] | undefined): boolean {
  const u = parseUrl(raw);
  if (!u) return false;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  const host = u.host.toLowerCase();
  return !!network?.some((h) => h.toLowerCase() === host && !h.includes('*'));
}
