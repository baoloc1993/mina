import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type Config, loadProdEnv, parseTarget, validateProdConfig } from "./env.ts";

const good: Config = {
  databaseUrl: "postgresql://postgres:pw@db.abc.supabase.co:5432/postgres", supabaseUrl: "https://abc.supabase.co",
  serviceKey: "k", signingKeyPath: "/keys/prod-1.pem", signingKeyId: "prod-1",
};

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const old = { ...process.env };
  for (const k of ["DATABASE_URL", "SIGNING_KEY_PATH", "SIGNING_KEY_ID"]) delete process.env[k];
  Object.assign(process.env, env);
  try { fn(); } finally { process.env = old; }
}

test("validateProdConfig: cấu hình đủ và https → qua", () => {
  withEnv({ DATABASE_URL: good.databaseUrl, SIGNING_KEY_PATH: "/keys/prod-1.pem", SIGNING_KEY_ID: "prod-1" }, () => {
    validateProdConfig(good, "https://abc.supabase.co");
  });
});

test("validateProdConfig: từ chối http, localhost, khoá local-*, thiếu biến", () => {
  const env = { DATABASE_URL: good.databaseUrl, SIGNING_KEY_PATH: "/keys/prod-1.pem", SIGNING_KEY_ID: "prod-1" };
  withEnv(env, () => {
    assert.throws(() => validateProdConfig(good, "http://abc.supabase.co"), /https/);
    assert.throws(() => validateProdConfig(good, undefined), /SUPABASE_URL/);
    assert.throws(() => validateProdConfig({ ...good, serviceKey: undefined }, "https://abc.supabase.co"), /SERVICE_ROLE/);
    assert.throws(() => validateProdConfig({ ...good, databaseUrl: "postgresql://postgres:postgres@127.0.0.1:54322/postgres" }, "https://abc.supabase.co"), /local/);
    assert.throws(() => validateProdConfig({ ...good, signingKeyId: "local-1" }, "https://abc.supabase.co"), /local/);
  });
  withEnv({ ...env, SIGNING_KEY_PATH: undefined }, () => {
    assert.throws(() => validateProdConfig(good, "https://abc.supabase.co"), /SIGNING_KEY_PATH/);
  });
});

test("loadProdEnv: biến quyết định ghi vào đâu KHÔNG được lấy từ môi trường local đã nạp sẵn", () => {
  const dir = mkdtempSync(join(tmpdir(), "prodenv-"));
  const file = join(dir, ".env");
  writeFileSync(file, "SUPABASE_URL=https://abc.supabase.co\nSIGNING_KEY_ID=prod-1\n");
  const target: NodeJS.ProcessEnv = {
    DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres", // lọt từ deployment/local/.env qua make
    SIGNING_KEY_PATH: "deployment/local/keys/signing-local-1.pem",
    SIGNING_KEY_ID: "local-1",
    SUPABASE_SERVICE_ROLE_KEY: "local-service-key",
    OTHER: "giữ",
  };
  loadProdEnv(file, target);
  assert.equal(target.SUPABASE_URL, "https://abc.supabase.co");
  assert.equal(target.SIGNING_KEY_ID, "prod-1"); // file prod thắng
  assert.equal(target.DATABASE_URL, undefined); // thiếu ở file prod → bị xoá, không rơi về local
  assert.equal(target.SIGNING_KEY_PATH, undefined);
  assert.equal(target.SUPABASE_SERVICE_ROLE_KEY, undefined);
  assert.equal(target.OTHER, "giữ");
});

test("loadProdEnv: thiếu file → CONFIG_MISSING", () => {
  assert.throws(() => loadProdEnv(join(tmpdir(), "khong-co-file.env"), {}), /CONFIG_MISSING/);
});

test("parseTarget: chỉ rỗng / local / prod; Prod, production, bogus → lỗi (không rơi im lặng về local)", () => {
  assert.equal(parseTarget(undefined), "local");
  assert.equal(parseTarget(""), "local");
  assert.equal(parseTarget("local"), "local");
  assert.equal(parseTarget("prod"), "prod");
  for (const bad of ["Prod", "PROD", "production", "bogus", " prod"]) assert.throws(() => parseTarget(bad), /không hợp lệ/);
});
