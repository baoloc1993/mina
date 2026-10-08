// api-registry (CAP-DIST-05/06): GET /functions/v1/catalog — app tenant này thấy được + bản an toàn mới nhất.
// Lọc theo tenant nằm trong SQL (`catalog_for`); function này dùng service role CHỈ để gọi hàm đó với
// tenant_id lấy từ JWT đã xác thực và để ký URL Storage SAU khi đã lọc.
import { createClient } from "npm:@supabase/supabase-js@2";
import { authenticate, json } from "../_shared/auth.ts";
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

  // Địa chỉ công khai của API: secret PUBLIC_API_URL nếu đặt, không thì lấy từ Host người gọi đã dùng.
  const base = Deno.env.get("PUBLIC_API_URL") ?? publicOrigin(req.headers, Deno.env.get("SUPABASE_URL")!);
  const apps = await Promise.all(
    ((data ?? []) as CatalogRow[]).map(async (row) => {
      let url: string | null = null;
      if (row.package_path) {
        const signed = await sb.storage.from("packages").createSignedUrl(row.package_path, URL_TTL_SECONDS);
        url = signed.data?.signedUrl ? rewriteOrigin(signed.data.signedUrl, base) : null;
      }
      return toCatalogApp(row, url);
    }),
  );
  return json({ apps });
});
