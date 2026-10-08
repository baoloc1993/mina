// Whitelist cho sdk.net (CAP-RT-06, AC-8): host phải khớp ĐÚNG một mục manifest.network —
// không subdomain, không wildcard, chỉ http(s), không user:pass@. Dùng cho URL ban đầu lẫn mọi bước chuyển hướng.

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
  const host = u.hostname.toLowerCase();
  return !!network?.some((h) => h.toLowerCase() === host && !h.includes('*'));
}
