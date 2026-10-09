// promote · revoke · add-tester · set-plan · set-entitlement — thao tác quản trị registry trên máy người vận hành.
import type { Client } from "pg";
import { RegistryError } from "./errors.ts";
import { HOST } from "./manifest.ts";

async function getVersion(db: Client, appId: string, version: string) {
  const r = (await db.query("select status from public.app_versions where app_id = $1 and version = $2", [appId, version])).rows[0];
  if (!r) throw new RegistryError("VERSION_NOT_FOUND", `không có ${appId}@${version}`);
  return r.status as string;
}

export async function promote(db: Client, appId: string, version: string): Promise<void> {
  const status = await getVersion(db, appId, version);
  if (status !== "draft") throw new RegistryError("BAD_STATE", `${appId}@${version} đang ${status}, chỉ draft mới promote được`);
  await db.query("update public.app_versions set status = 'published', published_at = now() where app_id = $1 and version = $2", [appId, version]);
}

export async function revoke(db: Client, appId: string, version: string): Promise<void> {
  const status = await getVersion(db, appId, version);
  if (status === "revoked") return; // idempotent
  await db.query("update public.app_versions set status = 'revoked', revoked_at = now() where app_id = $1 and version = $2", [appId, version]);
}

async function tenantByEmail(db: Client, email: string): Promise<string> {
  const r = (await db.query("select t.id from public.tenants t join auth.users u on u.id = t.owner_user_id where u.email = $1", [email])).rows[0];
  if (!r) throw new RegistryError("TENANT_NOT_FOUND", `không có tenant của ${email}`);
  return r.id;
}

export async function addTester(db: Client, appId: string, version: string, email: string): Promise<void> {
  const status = await getVersion(db, appId, version);
  if (status !== "draft") throw new RegistryError("BAD_STATE", `${appId}@${version} đang ${status}, chỉ draft cần tenant thử`);
  const tenant = await tenantByEmail(db, email);
  await db.query("insert into public.app_version_testers (app_id, version, tenant_id) values ($1, $2, $3) on conflict do nothing", [appId, version, tenant]);
}

export async function setPlan(db: Client, email: string, plan: string): Promise<void> {
  const tenant = await tenantByEmail(db, email);
  if (!(await db.query("select 1 from public.plans where id = $1", [plan])).rowCount) {
    throw new RegistryError("PLAN_NOT_FOUND", `không có gói "${plan}"`);
  }
  await db.query("update public.tenants set plan = $2 where id = $1", [tenant, plan]);
}

/** `null` (chữ) -> không hết hạn; ngày ISO (`2026-09-01` hoặc `2026-09-01T00:00:00Z`) -> ISO UTC. Sai -> BAD_DATE. */
export function parseEntitlementUntil(raw: string): string | null {
  const t = raw.trim();
  if (t.toLowerCase() === "null") return null;
  const ok = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(t);
  const d = ok ? new Date(t.replace(" ", "T")) : new Date(NaN);
  if (Number.isNaN(d.getTime())) throw new RegistryError("BAD_DATE", `"${raw}" không phải ngày ISO (vd 2026-09-01 hoặc 2026-09-01T00:00:00Z) cũng không phải null`);
  return d.toISOString();
}

export async function setEntitlement(db: Client, email: string, raw: string): Promise<string | null> {
  const until = parseEntitlementUntil(raw);
  const tenant = await tenantByEmail(db, email);
  await db.query("update public.tenants set entitlement_until = $2 where id = $1", [tenant, until]);
  return until;
}

const MAX_CONFIG_BYTES = 64 * 1024;

/** Kiểm cấu hình app (vòng 6, hợp đồng `app-config`): object JSON ≤ 64 KB; khoá dành riêng `network` là mảng host hợp lệ như manifest. */
export function validateConfig(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new RegistryError("BAD_CONFIG", "cấu hình phải là một object JSON");
  if (Buffer.byteLength(JSON.stringify(raw), "utf8") > MAX_CONFIG_BYTES) throw new RegistryError("BAD_CONFIG", "cấu hình quá 64 KB");
  const net = (raw as Record<string, unknown>).network;
  if (net !== undefined) {
    if (!Array.isArray(net) || net.some((h) => typeof h !== "string" || h.includes("*") || !HOST.test(h))) {
      throw new RegistryError("BAD_CONFIG", 'khoá "network" phải là mảng host chữ thường, không wildcard (vd "vnexpress.net")');
    }
  }
  return raw as Record<string, unknown>;
}

export async function setConfig(db: Client, appId: string, raw: unknown): Promise<void> {
  const config = validateConfig(raw);
  if (!(await db.query("select 1 from public.apps where id = $1", [appId])).rowCount) throw new RegistryError("APP_NOT_FOUND", `không có app ${appId} (publish trước)`);
  await db.query(
    "insert into public.app_configs (app_id, config) values ($1, $2::jsonb) on conflict (app_id) do update set config = excluded.config",
    [appId, JSON.stringify(config)],
  );
}

export async function getConfig(db: Client, appId: string): Promise<Record<string, unknown>> {
  const r = (await db.query("select config from public.app_configs where app_id = $1", [appId])).rows[0];
  return (r?.config as Record<string, unknown> | undefined) ?? {};
}
