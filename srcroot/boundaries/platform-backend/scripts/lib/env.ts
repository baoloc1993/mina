// Cấu hình CLI từ biến môi trường (make đã nạp deployment/local/.env; chạy tay thì tự nạp). Không bao giờ in giá trị.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { RegistryError } from "./errors.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const BACKEND_DIR = resolve(here, "..", "..");
export const REPO_ROOT = resolve(BACKEND_DIR, "..", "..", "..");
export const LOCAL_DIR = resolve(REPO_ROOT, "deployment", "local");
export const PROD_DIR = resolve(REPO_ROOT, "deployment", "prod");

/** `REGISTRY_ENV=prod` → CLI nhắm Supabase Cloud (deployment/prod/.env). Mặc định local. */
export function isProd(): boolean {
  return process.env.REGISTRY_ENV === "prod";
}

// Biến quyết định CLI ghi vào ĐÂU và ký bằng GÌ: ở chế độ prod chỉ lấy từ deployment/prod/.env, không bao giờ từ môi trường
// đã nạp sẵn (make nạp deployment/local/.env vào mọi recipe → publish nhầm lên local hoặc ký bằng khoá local).
const PROD_CRITICAL = ["DATABASE_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SIGNING_KEY_PATH", "SIGNING_KEY_ID"];

export function loadProdEnv(file = resolve(PROD_DIR, ".env"), target: NodeJS.ProcessEnv = process.env): void {
  if (!existsSync(file)) throw new RegistryError("CONFIG_MISSING", `thiếu ${file} (xem deployment/prod/README.md)`);
  const parsed = parseEnv(readFileSync(file, "utf8")) as Record<string, string>;
  for (const k of PROD_CRITICAL) if (!(k in parsed)) delete target[k];
  for (const [k, v] of Object.entries(parsed)) target[k] = v;
}

export function loadLocalEnv(): void {
  if (isProd()) return loadProdEnv();
  const f = resolve(LOCAL_DIR, ".env");
  if (existsSync(f)) {
    try {
      process.loadEnvFile(f);
    } catch {
      /* .env hỏng thì dùng mặc định */
    }
  }
}

export type Config = {
  databaseUrl: string; supabaseUrl: string; serviceKey: string | undefined;
  signingKeyPath: string | undefined; signingKeyId: string;
};

/** Chế độ prod: không mặc định nào, không localhost, https, khoá ký không phải `local-*`. Ném CONFIG_MISSING nếu sai. */
export function validateProdConfig(c: Config, publicUrl: string | undefined): void {
  const miss = (name: string, why: string): never => {
    throw new RegistryError("CONFIG_MISSING", `prod: ${name} ${why} (deployment/prod/.env)`);
  };
  if (!publicUrl) miss("SUPABASE_URL", "chưa đặt");
  if (!/^https:\/\//.test(publicUrl!)) miss("SUPABASE_URL", "phải là https://");
  if (!c.serviceKey) miss("SUPABASE_SERVICE_ROLE_KEY", "chưa đặt");
  if (!process.env.DATABASE_URL) miss("DATABASE_URL", "chưa đặt (không có mặc định ở prod)");
  if (/127\.0\.0\.1|localhost|10\.0\.2\.2/.test(c.databaseUrl + c.supabaseUrl)) miss("DATABASE_URL/SUPABASE_URL", "đang trỏ về máy local");
  if (!process.env.SIGNING_KEY_PATH) miss("SIGNING_KEY_PATH", "chưa đặt (không dùng khoá local)");
  if (!process.env.SIGNING_KEY_ID || /^local-/.test(c.signingKeyId)) miss("SIGNING_KEY_ID", "chưa đặt hoặc là khoá local (dùng prod-1)");
}

export function config(): Config {
  if (isProd()) {
    const c: Config = {
      databaseUrl: process.env.DATABASE_URL ?? "",
      supabaseUrl: process.env.SUPABASE_URL ?? "",
      serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      signingKeyPath: process.env.SIGNING_KEY_PATH,
      signingKeyId: process.env.SIGNING_KEY_ID ?? "",
    };
    validateProdConfig(c, process.env.SUPABASE_URL);
    return c;
  }
  return {
    databaseUrl: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    supabaseUrl: process.env.SUPABASE_URL_LOCAL ?? "http://127.0.0.1:54321",
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    signingKeyPath: process.env.SIGNING_KEY_PATH ?? resolve(LOCAL_DIR, "keys", "signing-local-1.pem"),
    signingKeyId: process.env.SIGNING_KEY_ID ?? "local-1",
  };
}

export function requireServiceKey(c: Config): string {
  if (!c.serviceKey) throw new RegistryError("CONFIG_MISSING", "thiếu SUPABASE_SERVICE_ROLE_KEY (deployment/local/.env)");
  return c.serviceKey;
}
