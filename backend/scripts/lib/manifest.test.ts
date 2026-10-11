import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseEntitlementUntil, validateConfig } from "./admin.ts";
import { RegistryError } from "./errors.ts";
import { readManifest, receivesOf } from "./manifest.ts";
import { renderSyncRules } from "./syncrules.ts";

const BASE = { id: "vn.app.x", name: "X", version: "1.0.0", sdk: "^0.1", entry: "index.html" };

function read(extra: object) {
  const dir = mkdtempSync(join(tmpdir(), "mf-"));
  try {
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...BASE, ...extra }));
    writeFileSync(join(dir, "index.html"), "<p>x</p>");
    return readManifest(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const bad = (extra: object) => assert.throws(() => read(extra), (e) => e instanceof RegistryError && e.code === "BAD_MANIFEST", JSON.stringify(extra));

test("sdk: nhận range (^0.1, >=0.1 <1, 0.1.x) và \"0\" của hello cũ; từ chối chuỗi lạ", () => {
  for (const sdk of ["^0.1", "0", ">=0.1.0 <1", "0.1.x", "~0.1.2"]) assert.equal(read({ sdk }).sdk, sdk);
  for (const sdk of ["", "latest", "^abc", "0.1; drop"]) bad({ sdk });
});

test("scopes: chỉ tên hợp lệ của SDK 0.1.0; scope lạ → BAD_MANIFEST", () => {
  assert.deepEqual(read({ scopes: ["db", "db.own", "core.tags:read", "core.files:write", "intent.send", "notify.local", "storage.files", "net", "ui.native", "auth.token"] }).scopes.length, 10);
  bad({ scopes: ["core.tags"] });
  bad({ scopes: ["root"] });
});

test("intents: mảng cũ = receives; object { sends, receives } nhận cả hai; sai khuôn → BAD_MANIFEST", () => {
  const recv = { type: "cal.reminder.create", version: "1", schema: { type: "object" } };
  assert.deepEqual(receivesOf(read({ intents: [recv] })), [recv]);
  const m = read({ intents: { sends: [{ type: "cal.reminder.create", version: "1" }], receives: [recv] } });
  assert.deepEqual(receivesOf(m), [recv]);
  assert.deepEqual(receivesOf(read({ intents: { sends: [{ type: "a", version: "1" }] } })), []);
  assert.deepEqual(receivesOf(read({})), []);
  bad({ intents: { sends: [{ type: "a" }] } });
  bad({ intents: { sends: "a" } });
  bad({ intents: { receives: [{ version: "1" }] } });
  bad({ intents: 5 });
});

test("trường tuỳ chọn: icon, description, offline, network (host chữ thường, không wildcard)", () => {
  const m = read({ icon: "icon.png", description: "Mô tả", offline: true, network: ["api.example.com", "localhost:8080"] });
  assert.deepEqual([m.icon, m.description, m.offline], ["icon.png", "Mô tả", true]);
  bad({ icon: 1 });
  bad({ description: {} });
  bad({ offline: "yes" });
  bad({ network: ["*.example.com"] });
  bad({ network: ["*"] });
  bad({ network: ["API.Example.com"] });
  bad({ network: ["https://x.com/path"] });
  bad({ network: "x.com" });
});

test("set-entitlement: ngày ISO → UTC, null → null, sai → BAD_DATE", () => {
  assert.equal(parseEntitlementUntil("2026-09-01"), "2026-09-01T00:00:00.000Z");
  assert.equal(parseEntitlementUntil("2026-09-01T10:00:00+07:00"), "2026-09-01T03:00:00.000Z");
  assert.equal(parseEntitlementUntil("null"), null);
  for (const s of ["", "hôm qua", "2026-13-45", "01/09/2026"]) {
    assert.throws(() => parseEntitlementUntil(s), (e) => e instanceof RegistryError && e.code === "BAD_DATE", s);
  }
});

test("sync rules: installations có id + position; bucket core theo tenant; mỗi app một bucket", () => {
  const y = renderSyncRules([{ id: "vn.app.hello", table_prefix: "app_hello", tables: ["app_hello_items"] }]);
  assert.match(y, /select app_id as id, app_id, tenant_id, version, enabled, position, installed_at, updated_at from installations/);
  assert.match(y, /  core:\n    parameters: select request\.jwt\(\) ->> 'tenant_id' as tenant_id\n    data:\n      - select \* from core_contacts where tenant_id = bucket\.tenant_id\n      - select \* from core_files[^\n]*\n      - select \* from core_net_grants[^\n]*\n      - select \* from core_tags/);
  assert.match(y, /  app_hello:\n/);
});

test("scope net.user-approved (vòng 6): hợp lệ khi đi cùng net; thiếu net → BAD_MANIFEST", () => {
  assert.ok(read({ scopes: ["net", "net.user-approved"], network: [] }).scopes.includes("net.user-approved"));
  bad({ scopes: ["net.user-approved"] });
  bad({ scopes: ["db.own", "ui.native", "net.user-approved"] });
});

test("config app (vòng 6): object ≤ 64 KB; network phải là host hợp lệ không wildcard", () => {
  assert.deepEqual(validateConfig({ sources: [], network: ["vnexpress.net", "10.0.2.2:8787"] }).network, ["vnexpress.net", "10.0.2.2:8787"]);
  assert.deepEqual(validateConfig({}), {});
  for (const x of [null, [], "x", 5]) assert.throws(() => validateConfig(x), (e) => e instanceof RegistryError && e.code === "BAD_CONFIG");
  for (const network of ["a.vn", ["*.vn"], ["https://a.vn"], ["A.VN"], [5], ["a.vn/rss"], ["user:pw@a.vn"]]) {
    assert.throws(() => validateConfig({ network }), (e) => e instanceof RegistryError && e.code === "BAD_CONFIG", JSON.stringify(network));
  }
  assert.throws(() => validateConfig({ big: "x".repeat(70_000) }), (e) => e instanceof RegistryError && e.code === "BAD_CONFIG");
});

test("sync rules: bucket core có core_net_grants (vòng 6)", () => {
  assert.match(renderSyncRules([]), /select \* from core_net_grants where tenant_id = bucket\.tenant_id/);
});
