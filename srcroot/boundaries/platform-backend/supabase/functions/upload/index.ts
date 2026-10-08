// api-upload v1 (CAP-SYNC-03): nhận lô thay đổi từ sync client, ghi Postgres BẰNG JWT CỦA NGƯỜI GỌI
// (không service role) để RLS `WITH CHECK` áp thật. tenant_id luôn lấy từ claim JWT, không từ body.
// HTTP 200 khi lô hợp lệ; từng thay đổi có `status` (ACCEPTED | IGNORED | REJECTED). `ok` giữ cho connector vòng 1.
import { createClient } from "npm:@supabase/supabase-js@2";
import { authenticate, json } from "../_shared/auth.ts";
import { MAX_OPS, type Op, type PatchOutcome, processOps, type Rejection, type Store, type StoreError } from "./upload_logic.ts";

function makeStore(token: string, tenantId: string): Store {
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });
  const toErr = (e: { code?: string; message: string }): StoreError => ({ error: { code: e.code, message: e.message } });

  return {
    async allowedTables() {
      const { data, error } = await sb.from("app_tables").select("table_name");
      if (error) throw new Error(error.message);
      return new Set((data ?? []).map((r: { table_name: string }) => r.table_name));
    },

    async patch(table, id, data, deletedAt): Promise<PatchOutcome | StoreError> {
      const payload: Record<string, unknown> = { ...data };
      if (deletedAt) payload.deleted_at = deletedAt;
      if (Object.keys(payload).length > 0) {
        const { data: rows, error } = await sb.from(table).update(payload).eq("id", id).is("deleted_at", null).select("id");
        if (error) return toErr(error);
        if (rows && rows.length > 0) return "updated";
      }
      // Không cập nhật được dòng nào (hoặc không có gì để cập nhật): dò trạng thái dòng.
      const { data: probe, error } = await sb.from(table).select("id, deleted_at").eq("id", id).limit(1);
      if (error) return toErr(error);
      if (!probe || probe.length === 0) return "missing";
      if (probe[0].deleted_at) return "deleted";
      return Object.keys(payload).length > 0 ? "missing" : "updated"; // sống mà update 0 dòng ⇒ RLS chặn
    },

    async insert(table, row) {
      const { error } = await sb.from(table).insert(row);
      return error ? toErr(error) : null;
    },

    async reject(rec: Rejection) {
      // Không để lỗi ghi hàng đợi lỗi làm hỏng cả lô.
      await sb.from("sync_rejections").insert({ ...rec, tenant_id: tenantId });
    },
  };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;

  let ops: Op[];
  try {
    ops = (await req.json()).ops;
    if (!Array.isArray(ops) || ops.length > MAX_OPS) throw new Error();
  } catch {
    return json({ error: "BAD_REQUEST", detail: `cần { ops: [...] } tối đa ${MAX_OPS} thay đổi` }, 400);
  }

  try {
    const results = await processOps(ops, caller.tenantId, makeStore(caller.token, caller.tenantId));
    return json({ server_time: new Date().toISOString(), results });
  } catch (e) {
    console.error("[upload] lỗi hạ tầng:", e instanceof Error ? e.message : e);
    return json({ error: "INTERNAL" }, 500);
  }
});
