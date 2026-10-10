// api-app-token (CAP-ID-03): đổi JWT phiên của người dùng thành JWT ngắn hạn theo từng mini app.
// tenant_id lấy từ JWT phiên (đã xác thực), KHÔNG từ body. Body chỉ có { app_id }.
// Vòng 2: chỉ cấp khi tenant đã cài và bật app (đọc `installations` bằng JWT người gọi → RLS áp thật).
import { SignJWT } from "npm:jose@5";
import { createClient } from "npm:@supabase/supabase-js@2";
import { authenticate, decodeClaims, json } from "../_shared/auth.ts";
import { enforceRate } from "../_shared/ratelimit.ts";

const encoder = new TextEncoder();

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const limited = await enforceRate("issue-app-token", caller.userId); // vòng 7
  if (limited) return limited;

  let body: { app_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "BAD_REQUEST", detail: "body phải là JSON { app_id }" }, 400);
  }
  const appId = body.app_id;
  if (!appId || !/^[a-z0-9]+(\.[a-z0-9-]+)+$/.test(appId)) {
    return json({ error: "BAD_APP_ID", detail: "app_id dạng reverse-domain chữ thường, vd vn.app.hello" }, 400);
  }

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: `Bearer ${caller.token}` } },
    auth: { persistSession: false },
  });
  const { data: inst, error } = await sb.from("installations").select("enabled").eq("app_id", appId).maybeSingle();
  if (error) {
    console.error("[issue-app-token]", error.message);
    return json({ error: "INTERNAL" }, 500);
  }
  if (!inst || !inst.enabled) return json({ error: "APP_NOT_INSTALLED" }, 403);

  const ttl = Number(Deno.env.get("APP_TOKEN_TTL_SECONDS") ?? "900");
  const now = Math.floor(Date.now() / 1000);
  const rawSecret = Deno.env.get("APP_TOKEN_SECRET");
  if (!rawSecret) return json({ error: "SERVER_MISCONFIGURED", detail: "thiếu APP_TOKEN_SECRET" }, 500);
  const claims = decodeClaims(caller.token);
  const jwt = await new SignJWT({ tenant_id: caller.tenantId, app_id: appId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(claims?.sub ?? caller.userId))
    .setIssuedAt(now)
    .setExpirationTime(now + ttl)
    .sign(encoder.encode(rawSecret));

  // Vòng 7: đếm ngày dùng (số đo H3). Lỗi ghi chỉ log — không làm hỏng việc cấp token.
  try {
    const svc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const { error: openErr } = await svc.rpc("record_app_open", { p_tenant: caller.tenantId, p_app: appId });
    if (openErr) console.error("[issue-app-token] ghi app_opens_daily lỗi:", openErr.message);
  } catch (e) {
    console.error("[issue-app-token] ghi app_opens_daily ngoại lệ:", e instanceof Error ? e.message : e);
  }

  return json({ token: jwt, expires_at: now + ttl });
});
