// Đọc + kiểm manifest.json của mini app, đóng gói zip có tính tái lập (cùng nội dung → cùng sha256).
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { zipSync } from "fflate";
import { RegistryError } from "./errors.ts";

export type Intent = { type: string; version: string; schema: unknown };
export type SendIntent = { type: string; version: string };
/** `intents`: dạng mảng cũ (= receives) hoặc object manifest v0 `{ sends, receives }`. Giữ nguyên dạng gốc trong manifest đã lưu. */
export type Manifest = {
  id: string; name: string; version: string; sdk: string; entry: string;
  scopes: string[]; tables: string[]; intents: Intent[] | { sends?: SendIntent[]; receives?: Intent[] };
  [k: string]: unknown;
};

/** Phạm vi hợp lệ của manifest v0 (SDK 0.1.0; vòng 6 thêm `net.user-approved`). `db` là alias `db.own` của vòng 1. */
export const VALID_SCOPES = new Set([
  "db", "db.own", "core.tags:read", "core.tags:write", "core.contacts:read", "core.contacts:write",
  "core.files:read", "core.files:write", "intent.send", "notify.local", "storage.files", "net", "net.user-approved", "ui.native", "auth.token",
]);
const SDK_RANGE = /^[\^~<>=]*\s*\d+(\.(\d+|x|\*))*(\s+[\^~<>=]*\s*\d+(\.(\d+|x|\*))*)*$/;
export const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;

/** Intent mà app NHẬN (đăng ký vào `intent_schemas`): mảng cũ hoặc `intents.receives`. */
export function receivesOf(m: Manifest): Intent[] {
  return Array.isArray(m.intents) ? m.intents : (m.intents.receives ?? []);
}

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
  if (typeof raw.sdk !== "string" || !SDK_RANGE.test(raw.sdk.trim())) bad('sdk phải là semver range, vd "^0.1" (hoặc "0" của hello cũ)');
  if (typeof raw.entry !== "string" || !existsSync(join(dir, raw.entry))) bad(`entry "${String(raw.entry)}" không có trong thư mục app — entry phải nằm cạnh manifest.json (nếu app có bước build, publish thư mục đã build)`);
  const scopes = raw.scopes ?? [];
  const tables = raw.tables ?? [];
  if (!Array.isArray(scopes) || scopes.some((s) => typeof s !== "string")) bad("scopes phải là mảng chuỗi");
  if (!Array.isArray(tables) || tables.some((t) => typeof t !== "string" || !/^[a-z][a-z0-9_]*$/.test(t))) {
    bad("tables phải là mảng tên ngắn chữ thường (vd \"items\")");
  }
  const badScope = (scopes as string[]).find((sc) => !VALID_SCOPES.has(sc));
  if (badScope !== undefined) bad(`scope "${badScope}" không hợp lệ — dùng: ${[...VALID_SCOPES].join(", ")}`);
  if ((scopes as string[]).includes("net.user-approved") && !(scopes as string[]).includes("net")) {
    bad('scope "net.user-approved" đòi kèm scope "net" (SDK 0.1.2: xin quyền host chỉ có nghĩa khi app gọi được net.fetch)');
  }
  const isIntent = (i: unknown, needSchema: boolean): boolean => {
    const o = i as Record<string, unknown> | null;
    return !!o && typeof o === "object" && typeof o.type === "string" && typeof o.version === "string" && (!needSchema || o.schema === undefined || typeof o.schema === "object");
  };
  const intents = raw.intents ?? [];
  if (Array.isArray(intents)) {
    if (!intents.every((i) => isIntent(i, true))) bad("intents (dạng mảng) phải là mảng { type, version, schema }");
  } else if (intents && typeof intents === "object") {
    const { sends = [], receives = [] } = intents as { sends?: unknown; receives?: unknown };
    if (!Array.isArray(sends) || !sends.every((i) => isIntent(i, false))) bad("intents.sends phải là mảng { type: string, version: string }");
    if (!Array.isArray(receives) || !receives.every((i) => isIntent(i, true))) bad("intents.receives phải là mảng { type, version, schema }");
  } else bad("intents phải là mảng hoặc object { sends, receives }");
  for (const k of ["icon", "description"]) if (raw[k] !== undefined && typeof raw[k] !== "string") bad(`${k} phải là chuỗi`);
  if (raw.offline !== undefined && typeof raw.offline !== "boolean") bad("offline phải là true/false");
  if (raw.network !== undefined) {
    if (!Array.isArray(raw.network) || raw.network.some((h) => typeof h !== "string" || h.includes("*") || !HOST.test(h))) {
      bad('network phải là mảng host chữ thường, không wildcard (vd "api.example.com")');
    }
  }
  return { ...raw, scopes, tables, intents } as Manifest;
}

/** Zip mọi file trong thư mục app trừ file ẩn — GỒM `migrations/*.sql` (shell chạy cùng file trong SQLite để dựng schema cục bộ, từ vòng 3); thứ tự + mtime cố định. */
export function buildZip(dir: string): Uint8Array {
  const files: Record<string, [Uint8Array, { mtime: Date; level: 6 }]> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (name.startsWith(".")) continue;
      const full = join(d, name);
      const rel = relative(dir, full).split(sep).join("/");
      const st = lstatSync(full);
      if (st.isSymbolicLink()) throw new RegistryError("BAD_MANIFEST", `${rel} là symlink — không đóng gói liên kết tượng trưng (có thể kéo file ngoài thư mục app vào gói)`);
      if (st.isDirectory()) walk(full);
      else files[rel] = [readFileSync(full), { mtime: new Date("2000-01-01T00:00:00Z"), level: 6 }];
    }
  };
  walk(dir);
  return zipSync(files);
}
