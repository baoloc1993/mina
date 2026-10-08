// api-app-token (CAP-ID-03): đổi JWT phiên của người dùng thành JWT ngắn hạn theo từng mini app.
// tenant_id lấy từ JWT phiên (đã xác thực), KHÔNG từ body. Body chỉ có { app_id }.
import { SignJWT } from "npm:jose@5";

const encoder = new TextEncoder();

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);

  const auth = req.headers.get("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "UNAUTHORIZED" }, 401);

  // Xác thực phiên qua GoTrue (không tự giải mã JWT để khỏi tin payload chưa kiểm chữ ký).
  const authUrl = `${Deno.env.get("SUPABASE_URL")}/auth/v1/user`;
  const who = await fetch(authUrl, {
    headers: { authorization: `Bearer ${token}`, apikey: Deno.env.get("SUPABASE_ANON_KEY")! },
  });
  if (!who.ok) return json({ error: "UNAUTHORIZED" }, 401);

  // tenant_id nằm trong claim của JWT phiên (custom access token hook).
  const claims = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
  const tenantId = claims.tenant_id as string | undefined;
  if (!tenantId) return json({ error: "NO_TENANT" }, 403);

  let body: { app_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "BAD_REQUEST" }, 400);
  }
  const appId = body.app_id;
  if (!appId || !/^[a-z0-9]+(\.[a-z0-9-]+)+$/.test(appId)) {
    return json({ error: "BAD_APP_ID" }, 400);
  }

  const ttl = Number(Deno.env.get("APP_TOKEN_TTL_SECONDS") ?? "900");
  const now = Math.floor(Date.now() / 1000);
  const rawSecret = Deno.env.get("APP_TOKEN_SECRET");
  if (!rawSecret) return json({ error: "SERVER_MISCONFIGURED", detail: "thiếu APP_TOKEN_SECRET" }, 500);
  const secret = encoder.encode(rawSecret);
  const jwt = await new SignJWT({ tenant_id: tenantId, app_id: appId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuedAt(now)
    .setExpirationTime(now + ttl)
    .sign(secret);

  return json({ token: jwt, expires_at: now + ttl });
});
