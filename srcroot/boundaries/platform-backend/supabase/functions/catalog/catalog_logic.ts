// api-registry (catalog) — ánh xạ dòng `catalog_for` → phần tử response. Thuần, không mạng.
export type CatalogRow = {
  id: string; name: string; table_prefix: string; owner_tenant_id: string | null;
  version: string | null; sdk_range: string | null; package_path: string | null;
  sha256: string | null; signature: string | null; key_id: string | null;
  status: string | null; installed: boolean; enabled: boolean;
};

export type CatalogApp = Omit<CatalogRow, "package_path"> & { package_url: string | null; code?: string };

export function toCatalogApp(row: CatalogRow, signedUrl: string | null): CatalogApp {
  const { package_path: _drop, ...rest } = row;
  if (row.version === null) return { ...rest, package_url: null, code: "NO_SAFE_VERSION" };
  if (!signedUrl) return { ...rest, package_url: null, code: "PACKAGE_UNAVAILABLE" };
  return { ...rest, package_url: signedUrl };
}

/**
 * URL ký do Storage mang địa chỉ NỘI BỘ của docker (http://kong:8000) — thiết bị không với tới. Thay phần origin
 * bằng địa chỉ mà chính người gọi đã dùng để vào API (vd emulator: http://10.0.2.2:54321). Không đổi path/query/chữ ký.
 */
export function publicOrigin(headers: { get(name: string): string | null }, fallback: string): string {
  // Kong gửi host và cổng tách riêng: x-forwarded-host = "10.0.2.2", x-forwarded-port = "54321".
  let host = headers.get("x-forwarded-host");
  if (!host) return fallback;
  const port = headers.get("x-forwarded-port");
  if (port && !host.includes(":") && port !== "80" && port !== "443") host = `${host}:${port}`;
  const proto = headers.get("x-forwarded-proto") ?? "http";
  return `${proto}://${host}`;
}

export function rewriteOrigin(signedUrl: string, base: string): string {
  const u = new URL(signedUrl);
  const b = new URL(base);
  u.protocol = b.protocol;
  u.host = b.host;
  return u.toString();
}
