import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { unzipSync } from "fflate";
import { RegistryError } from "./errors.ts";
import { buildZip, derivePrefix, readManifest, semverCompare } from "./manifest.ts";
import { generateKeyFile, loadPrivateKey, publicOf, sha256, signDigest, verifyDigest } from "./sign.ts";
import { renderSyncRules } from "./syncrules.ts";

test("ký rồi xác minh: đúng khoá → true; sai nội dung / sai khoá → false", () => {
  const dir = mkdtempSync(join(tmpdir(), "reg-"));
  try {
    const pubFromGen = generateKeyFile(join(dir, "k.pem"));
    const priv = loadPrivateKey(join(dir, "k.pem"));
    assert.equal(publicOf(priv), pubFromGen);
    const digest = sha256(Buffer.from("gói"));
    const sig = signDigest(priv, digest);
    assert.equal(verifyDigest(pubFromGen, digest, sig), true);
    assert.equal(verifyDigest(pubFromGen, sha256(Buffer.from("gói khác")), sig), false);
    const other = generateKeyFile(join(dir, "k2.pem"));
    assert.equal(verifyDigest(other, digest, sig), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("thiếu khoá ký → SIGNING_KEY_MISSING", () => {
  assert.throws(() => loadPrivateKey(undefined), (e) => e instanceof RegistryError && e.code === "SIGNING_KEY_MISSING");
  assert.throws(() => loadPrivateKey("/khong/co/file.pem"), (e) => e instanceof RegistryError && e.code === "SIGNING_KEY_MISSING");
});

function makeApp(manifest: object): string {
  const dir = mkdtempSync(join(tmpdir(), "app-"));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "index.html"), "<p>hi</p>");
  mkdirSync(join(dir, "migrations"));
  writeFileSync(join(dir, "migrations", "001.sql"), "select 1");
  return dir;
}

test("zip tái lập (cùng nội dung → cùng sha256), bỏ migrations/, đúng file", () => {
  const dir = makeApp({ id: "vn.app.x", name: "X", version: "1.0.0", sdk: "0", entry: "index.html" });
  try {
    const a = buildZip(dir), b = buildZip(dir);
    assert.equal(sha256(a).toString("hex"), sha256(b).toString("hex"));
    assert.deepEqual(Object.keys(unzipSync(a)).sort(), ["index.html", "manifest.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manifest sai → BAD_MANIFEST", () => {
  for (const m of [
    { id: "Sai Id", name: "X", version: "1.0.0", sdk: "0", entry: "index.html" },
    { id: "vn.app.x", name: "X", version: "1.0", sdk: "0", entry: "index.html" },
    { id: "vn.app.x", name: "X", version: "1.0.0", sdk: "0", entry: "khong-co.html" },
    { id: "vn.app.x", name: "X", version: "1.0.0", sdk: "0", entry: "index.html", tables: ["Bad-Name"] },
  ]) {
    const dir = makeApp(m);
    try {
      assert.throws(() => readManifest(dir), (e) => e instanceof RegistryError && e.code === "BAD_MANIFEST", JSON.stringify(m));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("prefix mặc định và so sánh semver", () => {
  assert.equal(derivePrefix("vn.app.note"), "app_vn_app_note");
  assert.equal(derivePrefix("vn.app.private-a"), "app_vn_app_private_a");
  assert.ok(semverCompare("0.10.0", "0.9.9") > 0);
  assert.ok(semverCompare("1.0.0", "1.0.0") === 0);
});

test("sync-rules: mỗi app một bucket tham số theo installations.enabled, luôn lọc tenant_id", () => {
  const y = renderSyncRules([{ id: "vn.app.hello", table_prefix: "app_hello", tables: ["app_hello_items"] }]);
  assert.match(y, /app_hello:\n    parameters: select tenant_id from installations where tenant_id = request\.jwt\(\) ->> 'tenant_id' and app_id = 'vn\.app\.hello' and enabled = true/);
  assert.match(y, /select \* from app_hello_items where tenant_id = bucket\.tenant_id/);
  assert.match(y, /rejections:/);
  assert.doesNotMatch(y, /by_tenant/);
});
