// api-registry (CAP-DIST-05/06): GET /functions/v1/catalog — app tenant này thấy được + bản an toàn mới nhất.
// Lọc theo tenant nằm trong SQL (`catalog_for`); function này dùng service role CHỈ để gọi hàm đó với
// tenant_id lấy từ JWT đã xác thực và để ký URL Storage SAU khi đã lọc.
import { createClient } from "npm:@supabase/supabase-js@2";
import { authenticate, json } from "../_shared/auth.ts";
import { graceDays, toEntitlement } from "../_shared/entitlement_logic.ts";
import { type CatalogRow, publicOrigin, rewriteOrigin, toCatalogApp } from "./catalog_logic.ts";

const URL_TTL_SECONDS = 900;

Deno.serve(async (req) => {
  if (req.method !== "GET") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
  const { data, error } = await sb.rpc("catalog_for", { p_tenant: caller.tenantId });
  if (error) {
    console.error("[catalog]", error.message);
    return json({ error: "INTERNAL" }, 500);
  }

  // Vòng 3: thứ tự launcher + entitlement + manifest của version đang trả (service role, lọc theo tenant_id từ JWT đã xác thực).
  const rows = (data ?? []) as CatalogRow[];
  const appIds = rows.map((r) => r.id);
  const [inst, ten, vers, cfgs] = await Promise.all([
    sb.from("installations").select("app_id, position").eq("tenant_id", caller.tenantId),
    sb.from("tenants").select("plan, entitlement_until").eq("id", caller.tenantId).single(),
    appIds.length ? sb.from("app_versions").select("app_id, version, manifest").in("app_id", appIds) : Promise.resolve({ data: [], error: null }),
    appIds.length ? sb.from("app_configs").select("app_id, config").in("app_id", appIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (inst.error || ten.error || vers.error || cfgs.error) {
    console.error("[catalog]", inst.error?.message ?? ten.error?.message ?? vers.error?.message ?? cfgs.error?.message);
    return json({ error: "INTERNAL" }, 500);
  }
  const positions = new Map<string, number | null>((inst.data ?? []).map((r: { app_id: string; position: number | null }) => [r.app_id, r.position]));
  const manifests = new Map<string, unknown>((vers.data ?? []).map((r: { app_id: string; version: string; manifest: unknown }) => [`${r.app_id}@${r.version}`, r.manifest]));
  const configs = new Map<string, unknown>((cfgs.data ?? []).map((r: { app_id: string; config: unknown }) => [r.app_id, r.config]));
  const planRow = await sb.from("plans").select("max_apps").eq("id", ten.data.plan).maybeSingle();

  // Địa chỉ công khai của API: secret PUBLIC_API_URL nếu đặt, không thì lấy từ Host người gọi đã dùng.
  const base = Deno.env.get("PUBLIC_API_URL") ?? publicOrigin(req.headers, Deno.env.get("SUPABASE_URL")!);
  const apps = await Promise.all(
    rows.map(async (row) => {
      let url: string | null = null;
      if (row.package_path) {
        const signed = await sb.storage.from("packages").createSignedUrl(row.package_path, URL_TTL_SECONDS);
        url = signed.data?.signedUrl ? rewriteOrigin(signed.data.signedUrl, base) : null;
      }
      return toCatalogApp(row, url, positions.get(row.id) ?? null, manifests.get(`${row.id}@${row.version}`) ?? null, configs.get(row.id) ?? null);
    }),
  );
  return json({
    apps,
    server_time: new Date().toISOString(),
    entitlement: toEntitlement(ten.data, planRow.data, graceDays(Deno.env.get("ENTITLEMENT_GRACE_DAYS"))),
  });
});
