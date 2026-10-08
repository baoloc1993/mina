import { assertEquals } from "jsr:@std/assert@1";
import { type CatalogRow, manifestInfo, publicOrigin, rewriteOrigin, toCatalogApp } from "./catalog_logic.ts";

const row = (over: Partial<CatalogRow> = {}): CatalogRow => ({
  id: "vn.app.hello", name: "Hello", table_prefix: "app_hello", owner_tenant_id: null,
  version: "0.0.1", sdk_range: "0", package_path: "vn.app.hello/0.0.1.zip", sha256: "a".repeat(64),
  signature: "c2ln", key_id: "local-1", status: "published", installed: false, enabled: false, ...over,
});

Deno.test("app có bản an toàn: kèm package_url, không lộ package_path", () => {
  const a = toCatalogApp(row(), "http://x/signed");
  assertEquals(a.package_url, "http://x/signed");
  assertEquals(a.code, undefined);
  assertEquals("package_path" in a, false);
  assertEquals([a.sha256!.length, a.signature, a.key_id, a.table_prefix], [64, "c2ln", "local-1", "app_hello"]);
});

Deno.test("không còn bản an toàn → version null + NO_SAFE_VERSION", () => {
  const a = toCatalogApp(row({ version: null, package_path: null, sha256: null, signature: null, key_id: null, status: null, installed: true, enabled: true }), null);
  assertEquals([a.version, a.package_url, a.code, a.installed], [null, null, "NO_SAFE_VERSION", true]);
});

Deno.test("ký URL lỗi → PACKAGE_UNAVAILABLE, không bịa URL", () => {
  const a = toCatalogApp(row(), null);
  assertEquals([a.package_url, a.code], [null, "PACKAGE_UNAVAILABLE"]);
});

Deno.test("URL ký: thay origin nội bộ bằng địa chỉ người gọi đã dùng, giữ nguyên path + chữ ký", () => {
  const signed = "http://kong:8000/storage/v1/object/sign/packages/vn.app.hello/0.0.1.zip?token=abc.def";
  assertEquals(rewriteOrigin(signed, "http://10.0.2.2:54321"), "http://10.0.2.2:54321/storage/v1/object/sign/packages/vn.app.hello/0.0.1.zip?token=abc.def");
});

Deno.test("publicOrigin: ghép x-forwarded-host + x-forwarded-port của Kong; thiếu thì dùng fallback", () => {
  const h = (o: Record<string, string>) => ({ get: (k: string) => o[k] ?? null });
  assertEquals(publicOrigin(h({ "x-forwarded-host": "10.0.2.2", "x-forwarded-port": "54321", "x-forwarded-proto": "http" }), "http://kong:8000"), "http://10.0.2.2:54321");
  assertEquals(publicOrigin(h({ "x-forwarded-host": "abc.supabase.co", "x-forwarded-port": "443", "x-forwarded-proto": "https" }), "http://kong:8000"), "https://abc.supabase.co");
  assertEquals(publicOrigin(h({ "x-forwarded-host": "127.0.0.1:54321" }), "http://kong:8000"), "http://127.0.0.1:54321");
  assertEquals(publicOrigin(h({}), "http://fallback:1"), "http://fallback:1");
});

Deno.test("position (vòng 3): mặc định null; có thì kèm theo, mọi trường cũ giữ nguyên", () => {
  assertEquals(toCatalogApp(row(), "http://x/signed").position, null);
  const a = toCatalogApp(row({ installed: true, enabled: true }), "http://x/signed", 2);
  assertEquals([a.position, a.package_url, a.table_prefix, a.installed], [2, "http://x/signed", "app_hello", true]);
  assertEquals(toCatalogApp(row({ version: null, package_path: null }), null, 0).position, 0);
});

Deno.test("description / scopes / network lấy từ manifest; thiếu → null / []; NO_SAFE_VERSION luôn rỗng", () => {
  const m = { description: "Xin chào", scopes: ["db", "net", 5], network: ["api.example.com"] };
  const a = toCatalogApp(row(), "http://x", null, m);
  assertEquals([a.description, a.scopes, a.network], ["Xin chào", ["db", "net"], ["api.example.com"]]);
  assertEquals(manifestInfo(null), { description: null, scopes: [], network: [] });
  assertEquals(manifestInfo({ description: "" }).description, null);
  const none = toCatalogApp(row({ version: null, package_path: null }), null, null, m);
  assertEquals([none.description, none.scopes, none.network, none.code], [null, [], [], "NO_SAFE_VERSION"]);
});
