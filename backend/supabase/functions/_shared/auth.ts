// Xác thực người gọi cho Edge Functions: hỏi GoTrue (không tự tin payload JWT chưa kiểm chữ ký).
// GoTrue kiểm cả `auth.sessions` còn tồn tại → phiên đã bị `revoke_device` bị chặn ngay ở đây,
// không phải chờ JWT hết hạn (DECISIONS vòng 2 — challenge pha I).

export type Caller = { token: string; tenantId: string; userId: string };

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function decodeClaims(token: string): Record<string, unknown> | null {
  try {
    const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(payload));
  } catch {
    return null;
  }
}

/** Trả `Caller` hoặc `Response` lỗi theo khuôn `{ error, detail? }`. */
export async function authenticate(req: Request): Promise<Caller | Response> {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "UNAUTHORIZED" }, 401);

  const who = await fetch(`${Deno.env.get("SUPABASE_URL")}/auth/v1/user`, {
    headers: { authorization: `Bearer ${token}`, apikey: Deno.env.get("SUPABASE_ANON_KEY")! },
  });
  if (!who.ok) return json({ error: "UNAUTHORIZED" }, 401);

  const claims = decodeClaims(token);
  const tenantId = claims?.tenant_id;
  if (typeof tenantId !== "string" || !tenantId) return json({ error: "NO_TENANT" }, 403);
  return { token, tenantId, userId: String(claims?.sub ?? "") };
}
