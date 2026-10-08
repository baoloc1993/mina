// Đọc + kiểm manifest.json của mini app, đóng gói zip có tính tái lập (cùng nội dung → cùng sha256).
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { zipSync } from "fflate";
import { RegistryError } from "./errors.ts";

export type Intent = { type: string; version: string; schema: unknown };
export type Manifest = {
  id: string; name: string; version: string; sdk: string; entry: string;
  scopes: string[]; tables: string[]; intents: Intent[];
  [k: string]: unknown;
};

export const APP_ID = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;
export const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export const derivePrefix = (id: string): string => `app_${id.replace(/[.-]/g, "_")}`;

export function semverKey(v: string): number[] {
  return v.split(".").map(Number);
}
export function semverCompare(a: string, b: string): number {
  const x = semverKey(a), y = semverKey(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

export function readManifest(dir: string): Manifest {
  const path = join(dir, "manifest.json");
  if (!existsSync(path)) throw new RegistryError("BAD_MANIFEST", `thiếu ${path}`);
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new RegistryError("BAD_MANIFEST", "manifest.json không phải JSON hợp lệ (kiểm dấu phẩy, ngoặc, nháy kép)");
  }
  const bad = (m: string): never => {
    throw new RegistryError("BAD_MANIFEST", m);
  };
  if (typeof raw.id !== "string" || !APP_ID.test(raw.id)) bad("id phải là reverse-domain chữ thường, vd vn.app.note");
  if (typeof raw.name !== "string" || !raw.name.trim()) bad("thiếu name");
  if (typeof raw.version !== "string" || !SEMVER.test(raw.version)) bad("version phải là semver x.y.z");
  if (typeof raw.sdk !== "string" || !raw.sdk) bad("thiếu sdk");
  if (typeof raw.entry !== "string" || !existsSync(join(dir, raw.entry))) bad(`entry "${String(raw.entry)}" không có trong thư mục app — entry phải nằm cạnh manifest.json (nếu app có bước build, publish thư mục đã build)`);
  const scopes = raw.scopes ?? [];
  const tables = raw.tables ?? [];
  if (!Array.isArray(scopes) || scopes.some((s) => typeof s !== "string")) bad("scopes phải là mảng chuỗi");
  if (!Array.isArray(tables) || tables.some((t) => typeof t !== "string" || !/^[a-z][a-z0-9_]*$/.test(t))) {
    bad("tables phải là mảng tên ngắn chữ thường (vd \"items\")");
  }
  const intents = raw.intents ?? [];
  if (!Array.isArray(intents) || intents.some((i) => !i || typeof i.type !== "string" || typeof i.version !== "string")) {
    bad("intents phải là mảng { type, version, schema }");
  }
  return { ...raw, scopes, tables, intents } as Manifest;
}

/** Zip mọi file trong thư mục app trừ `migrations/` (chỉ server cần) và file ẩn; thứ tự + mtime cố định. */
export function buildZip(dir: string): Uint8Array {
  const files: Record<string, [Uint8Array, { mtime: Date; level: 6 }]> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (name.startsWith(".")) continue;
      const full = join(d, name);
      const rel = relative(dir, full).split(sep).join("/");
      if (rel === "migrations") continue;
      if (statSync(full).isDirectory()) walk(full);
      else files[rel] = [readFileSync(full), { mtime: new Date("2000-01-01T00:00:00Z"), level: 6 }];
    }
  };
  walk(dir);
  return zipSync(files);
}
