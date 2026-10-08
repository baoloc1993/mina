// api-upload v1 (CAP-SYNC-03): nhận lô thay đổi từ sync client, ghi Postgres BẰNG JWT CỦA NGƯỜI GỌI
// (không service role) để RLS `WITH CHECK` áp thật. tenant_id luôn lấy từ claim JWT, không từ body.
// HTTP 200 khi lô hợp lệ; từng thay đổi có `status` (ACCEPTED | IGNORED | REJECTED). `ok` giữ cho connector vòng 1.
import { createClient } from "npm:@supabase/supabase-js@2";
import { authenticate, json } from "../_shared/auth.ts";
import { graceDays, isReadOnly } from "../_shared/entitlement_logic.ts";
import { MAX_OPS, type Op, type PatchOutcome, processOps, type Rejection, type Store, type StoreError } from "./upload_logic.ts";

function makeStore(token: string, tenantId: string): Store {
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });
  const pending: Record<string, unknown>[] = [];
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

    reject(rec: Rejection) {
      pending.push({ ...rec, tenant_id: tenantId });
      return Promise.resolve();
    },

    async flush() {
      // Một INSERT cho cả lô; lỗi ghi hàng đợi lỗi không làm hỏng lô (kết quả vẫn trả đúng).
      if (pending.length > 0) await sb.from("sync_rejections").upsert(pending.splice(0), { onConflict: "tenant_id,table_name,row_id,op,code", ignoreDuplicates: true });
    },
  };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;

  // Vòng 3: tenant quá ân hạn -> chỉ đọc. Từ chối CẢ LÔ, không ghi gì, không ghi sync_rejections (client giữ lô để gửi lại).
  const grace = graceDays(Deno.env.get("ENTITLEMENT_GRACE_DAYS"));
  const sbUser = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: `Bearer ${caller.token}` } },
    auth: { persistSession: false },
  });
  const ten = await sbUser.from("tenants").select("entitlement_until").eq("id", caller.tenantId).maybeSingle();
  if (ten.error) {
    console.error("[upload] đọc entitlement lỗi:", ten.error.message);
    return json({ error: "INTERNAL" }, 500);
  }
  if (isReadOnly(ten.data?.entitlement_until, grace)) {
    return json({
      error: "READ_ONLY",
      detail: `gói của tenant đã hết hạn quá ${grace} ngày ân hạn: chỉ đọc; gia hạn rồi gửi lại (thay đổi chưa gửi vẫn được giữ trên máy)`,
    }, 403);
  }

  let ops: Op[];
  try {
    ops = (await req.json()).ops;
    if (!Array.isArray(ops) || ops.length > MAX_OPS) throw new Error();
  } catch {
    return json({ error: "BAD_REQUEST", detail: `body phải là JSON { ops: [...] } với tối đa ${MAX_OPS} thay đổi` }, 400);
  }

  try {
    const results = await processOps(ops, caller.tenantId, makeStore(caller.token, caller.tenantId));
    return json({ server_time: new Date().toISOString(), results });
  } catch (e) {
    console.error("[upload] lỗi hạ tầng:", e instanceof Error ? e.message : e);
    return json({ error: "INTERNAL" }, 500);
  }
});
