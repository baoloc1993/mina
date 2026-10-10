// health (vòng 7, `api-ops`): GET /functions/v1/health — công khai, không JWT. Một truy vấn nhỏ qua service role.
// Trả đúng 3 trường { ok, db, version }; version = biến GIT_SHA đặt lúc deploy (thiếu → "dev").
import { createClient } from "npm:@supabase/supabase-js@2";
import { json } from "../_shared/auth.ts";
import { log, serveLogged } from "../_shared/log.ts";
import { healthBody } from "./health_logic.ts";

serveLogged("health", async (req, rid) => {
  if (req.method !== "GET") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
  let dbOk = false;
  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    // `plans` có sẵn từ vòng 2; đọc 1 dòng đủ chứng minh kết nối + quyền.
    const { error } = await sb.from("plans").select("id").limit(1);
    dbOk = !error;
    if (error) log("error", "health", "db_failed", { error: error.message }, rid);
  } catch (e) {
    log("error", "health", "exception", { error: e instanceof Error ? e.message : String(e) }, rid);
  }
  const { status, body } = healthBody(dbOk, Deno.env.get("GIT_SHA"));
  return json(body, status);
});
