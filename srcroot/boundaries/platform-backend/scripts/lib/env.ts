// Cấu hình CLI từ biến môi trường (make đã nạp deployment/local/.env; chạy tay thì tự nạp). Không bao giờ in giá trị.
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RegistryError } from "./errors.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const BACKEND_DIR = resolve(here, "..", "..");
export const REPO_ROOT = resolve(BACKEND_DIR, "..", "..", "..");
export const LOCAL_DIR = resolve(REPO_ROOT, "deployment", "local");

export function loadLocalEnv(): void {
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

export function config(): Config {
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
