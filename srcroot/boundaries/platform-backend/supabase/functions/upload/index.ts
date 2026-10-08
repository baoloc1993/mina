// api-upload (vòng 1): nhận lô thay đổi từ sync client, ghi Postgres BẰNG JWT CỦA NGƯỜI GỌI
// (không service role) để RLS `WITH CHECK` áp thật. tenant_id luôn bị ghi đè từ claim JWT.
// Vòng 2 thêm LWW theo trường + xoá thắng sửa + hàng đợi lỗi.
import { createClient } from "npm:@supabase/supabase-js@2";

type Op = { op: "PUT" | "PATCH" | "DELETE"; table: string; id: string; data?: Record<string, unknown> };

const ALLOWED = new Set(["app_hello_items"]);
const EDITABLE = new Set(["title", "done", "created_at", "updated_at", "deleted_at"]);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
  const authHeader = req.headers.get("authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "UNAUTHORIZED" }, 401);

  const claims = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
  const tenantId = claims.tenant_id as string | undefined;
  if (!tenantId) return json({ error: "NO_TENANT" }, 403);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });

  let ops: Op[];
  try {
    ops = (await req.json()).ops;
    if (!Array.isArray(ops)) throw new Error();
  } catch {
    return json({ error: "BAD_REQUEST" }, 400);
  }

  const results: { id: string; ok: boolean; error?: string }[] = [];
  for (const op of ops) {
    if (!ALLOWED.has(op.table)) {
      results.push({ id: op.id, ok: false, error: "TABLE_NOT_ALLOWED" });
      continue;
    }
    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(op.data ?? {})) if (EDITABLE.has(k)) data[k] = v;

    let error;
    if (op.op === "PUT") {
      ({ error } = await sb.from(op.table).upsert({ ...data, id: op.id, tenant_id: tenantId }));
    } else if (op.op === "PATCH") {
      ({ error } = await sb.from(op.table).update(data).eq("id", op.id));
    } else {
      // DELETE từ client luôn thành xoá mềm.
      const now = new Date().toISOString();
      ({ error } = await sb.from(op.table).update({ deleted_at: now, updated_at: now }).eq("id", op.id));
    }
    results.push(error ? { id: op.id, ok: false, error: error.message } : { id: op.id, ok: true });
  }
  return json({ results });
});
