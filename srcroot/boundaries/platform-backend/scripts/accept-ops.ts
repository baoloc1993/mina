// Acceptance W7 (phía server, AC-1/AC-3): `health`, trần gọi theo user (429 RATE_LIMITED, chưa áp gì khi bị chặn),
// `app_opens_daily` do issue-app-token ghi, RLS + quyền của bảng mới.
//   npm run accept:ops     (cần `make dev`; Edge Function đã nạp bản vòng 7 — `docker restart supabase_edge_runtime_platform-backend`)
// Dùng user riêng `ratelimit@test.local` cho phần bị chặn để không làm 429 các script accept khác (cùng a@test.local).
import { randomUUID } from "node:crypto";
import pg from "pg";
import { config, loadLocalEnv } from "./lib/env.ts";

loadLocalEnv();
const cfg = config();
const API = "http://127.0.0.1:54321";
const ANON = process.env.SUPABASE_ANON_KEY ?? "";
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const A = "a@test.local";
const B = "b@test.local";
const RL = "ratelimit@test.local";

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) passed++;
  else failures.push(`${name}${detail ? " — " + detail : ""}`);
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : "  → " + detail}`);
}
const section = (t: string): void => console.log(`\n${t}`);
const js = (x: unknown) => JSON.stringify(x);

type Resp = { status: number; body: any; headers: Headers };
async function http(url: string, init: RequestInit & { token?: string } = {}): Promise<Resp> {
  const headers: Record<string, string> = { apikey: ANON, ...(init.headers as Record<string, string> | undefined) };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.body && !headers["content-type"]) headers["content-type"] = "application/json";
  const r = await fetch(url, { ...init, headers });
  const text = await r.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* giữ chuỗi */ }
  return { status: r.status, body, headers: r.headers };
}
async function session(email: string, tries = 3): Promise<string> {
  try {
    return await sessionOnce(email);
  } catch (e) {
    if (tries <= 1) throw e;
    await new Promise((r) => setTimeout(r, 1500)); // lần đầu tạo user/cold start đôi khi trả otp_expired
    return session(email, tries - 1);
  }
}
async function sessionOnce(email: string): Promise<string> {
  const g = await http(`${API}/auth/v1/admin/generate_link`, { method: "POST", token: SERVICE, body: js({ type: "magiclink", email }) });
  const hash = g.body?.hashed_token ?? g.body?.properties?.hashed_token;
  const v = await http(`${API}/auth/v1/verify`, { method: "POST", body: js({ type: "magiclink", token_hash: hash }) });
  if (v.status !== 200) throw new Error(`phiên lỗi ${v.status} ${js(v.body)}`);
  return v.body.access_token as string;
}
const rest = (path: string, token: string) => http(`${API}/rest/v1/${path}`, { token });

/** Gọi `fn` tới khi gặp 429 hoặc hết `max` lần. Trả số lần gọi và lần 429 đầu. */
async function hammer(fn: () => Promise<Resp>, max: number): Promise<{ calls: number; first429: Resp | null }> {
  for (let i = 1; i <= max; i++) {
    const r = await fn();
    if (r.status === 429) return { calls: i, first429: r };
  }
  return { calls: max, first429: null };
}

async function main(): Promise<void> {
  if (!ANON || !SERVICE) throw new Error("thiếu SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY trong deployment/local/.env");
  const db = new pg.Client({ connectionString: cfg.databaseUrl });
  await db.connect();
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;

  section("health — công khai, đúng 3 trường");
  const h = await http(`${API}/functions/v1/health`);
  check("GET /health không JWT → 200", h.status === 200, `status ${h.status}`);
  check("body đúng 3 trường { ok, db, version }", js(Object.keys(h.body).sort()) === js(["db", "ok", "version"]), js(h.body));
  check("ok = true, db = true", h.body?.ok === true && h.body?.db === true);
  const hp = await http(`${API}/functions/v1/health`, { method: "POST", body: js({}) });
  check("POST /health → 405", hp.status === 405, `status ${hp.status}`);

  const ta = await session(A);
  const tb = await session(B);
  const trl = await session(RL);

  section("catalog — trần 30 lần/phút/user → 429 RATE_LIMITED");
  const cat = await hammer(() => http(`${API}/functions/v1/catalog`, { token: trl }), 70);
  check("gọi dồn catalog gặp 429", cat.first429 !== null, `${cat.calls} lần không 429`);
  if (cat.first429) {
    check("429 xuất hiện sau ≥ 30 lần qua (trần = 30)", cat.calls >= 31, `429 ở lần ${cat.calls}`);
    check("body { error: RATE_LIMITED, retry_after_s }", cat.first429.body?.error === "RATE_LIMITED" && Number(cat.first429.body?.retry_after_s) >= 1, js(cat.first429.body));
    const ra = Number(cat.first429.headers.get("retry-after"));
    check("header Retry-After khớp 1..60", ra >= 1 && ra <= 60, String(ra));
  }
  const catB = await http(`${API}/functions/v1/catalog`, { token: tb });
  check("user khác (B) không bị ảnh hưởng", catB.status === 200, `status ${catB.status}`);
  const catNoAuth = await http(`${API}/functions/v1/catalog`);
  check("không JWT → 401 (xác thực trước, không đếm)", catNoAuth.status === 401, `status ${catNoAuth.status}`);

  section("upload — 429 nghĩa là CHƯA ÁP GÌ");
  const emptyOps = (token: string) => http(`${API}/functions/v1/upload`, { method: "POST", token, body: js({ ops: [] }) });
  const up = await hammer(() => emptyOps(trl), 160);
  check("gọi dồn upload gặp 429 (trần 120)", up.first429 !== null && up.calls >= 121, `${up.calls} lần`);
  const id = randomUUID();
  const blocked = await http(`${API}/functions/v1/upload`, {
    method: "POST", token: trl,
    body: js({ ops: [{ op: "PUT", table: "core_tags", id, data: { name: "ACC-OPS: không được ghi" } }] }),
  });
  check("PUT khi đang bị chặn → 429", blocked.status === 429, `status ${blocked.status}`);
  const rows = await q("select 1 from public.core_tags where id = $1", [id]);
  check("dòng KHÔNG được ghi vào DB khi bị 429", rows.length === 0);
  const ok = await http(`${API}/functions/v1/upload`, {
    method: "POST", token: tb, body: js({ ops: [{ op: "PUT", table: "core_tags", id: randomUUID(), data: { name: "ACC-OPS: B ghi bình thường" } }] }),
  });
  check("user khác (B) vẫn ghi được", ok.status === 200 && ok.body?.results?.[0]?.status !== "REJECTED", js(ok.body));

  section("issue-app-token — ghi app_opens_daily");
  const inst = await q(
    `select i.app_id, i.tenant_id from public.installations i
       join public.tenants t on t.id = i.tenant_id
       join auth.users u on u.id = t.owner_user_id
      where u.email = $1 and i.enabled limit 1`, [A]);
  if (inst.length === 0) {
    check("A có một app đã cài (cần seed)", false, "chạy `make seed` rồi thử lại");
  } else {
    const { app_id: appId, tenant_id: tenantId } = inst[0] as { app_id: string; tenant_id: string };
    const before = await q("select coalesce(sum(opens), 0)::int as n from public.app_opens_daily where tenant_id = $1 and app_id = $2 and day = (now() at time zone 'Asia/Ho_Chi_Minh')::date", [tenantId, appId]);
    const tok = await http(`${API}/functions/v1/issue-app-token`, { method: "POST", token: ta, body: js({ app_id: appId }) });
    check(`cấp token cho ${appId} → 200`, tok.status === 200 && typeof tok.body?.token === "string", `status ${tok.status} ${js(tok.body)}`);
    const after = await q("select coalesce(sum(opens), 0)::int as n from public.app_opens_daily where tenant_id = $1 and app_id = $2 and day = (now() at time zone 'Asia/Ho_Chi_Minh')::date", [tenantId, appId]);
    check("opens tăng đúng 1 sau một lần cấp token", after[0].n === before[0].n + 1, `${before[0].n} → ${after[0].n}`);
    const own = await rest(`app_opens_daily?select=app_id,day,opens&app_id=eq.${appId}`, ta);
    check("A đọc được dòng đếm của mình qua PostgREST", own.status === 200 && Array.isArray(own.body) && own.body.length >= 1, js(own.body));
    const other = await rest(`app_opens_daily?select=app_id&tenant_id=eq.${tenantId}`, tb);
    check("B đọc dòng đếm của A → 0 dòng", other.status === 200 && Array.isArray(other.body) && other.body.length === 0, js(other.body));
    const notInstalled = await http(`${API}/functions/v1/issue-app-token`, { method: "POST", token: ta, body: js({ app_id: "vn.app.khong-co" }) });
    const none = await q("select 1 from public.app_opens_daily where tenant_id = $1 and app_id = 'vn.app.khong-co'", [tenantId]);
    check("app chưa cài → 403 và KHÔNG ghi đếm", notInstalled.status === 403 && none.length === 0, `status ${notInstalled.status}`);
  }

  section("quyền bảng mới");
  const wr = await http(`${API}/rest/v1/app_opens_daily`, { method: "POST", token: ta, body: js({ tenant_id: randomUUID(), app_id: "x.y.z", day: "2026-10-10" }) });
  check("A ghi thẳng app_opens_daily bằng PostgREST → bị chặn", wr.status >= 400, `status ${wr.status}`);
  const rl = await rest("rate_limits?select=key", ta);
  check("A đọc rate_limits bằng PostgREST → bị chặn (không lộ khoá đếm)", rl.status >= 400, `status ${rl.status}`);
  const rpc = await http(`${API}/rest/v1/rpc/hit_rate_limit`, { method: "POST", token: ta, body: js({ p_key: "x:y", p_window_s: 60, p_max: 1 }) });
  check("A gọi RPC hit_rate_limit → bị chặn", rpc.status >= 400, `status ${rpc.status}`);
  const rpc2 = await http(`${API}/rest/v1/rpc/record_app_open`, { method: "POST", token: ta, body: js({ p_tenant: randomUUID(), p_app: "x.y.z" }) });
  check("A gọi RPC record_app_open → bị chặn", rpc2.status >= 400, `status ${rpc2.status}`);

  await q("delete from public.core_tags where name like 'ACC-OPS:%'");
  await q("delete from public.rate_limits where key like '%:' || (select id::text from auth.users where email = $1)", [RL]);
  await db.end();

  console.log(`\n${failures.length ? "✗" : "✓"} accept:ops — ${passed} kiểm đạt${failures.length ? `, ${failures.length} hỏng` : ""}`);
  if (failures.length) {
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("accept:ops lỗi:", e instanceof Error ? e.message : e);
  process.exit(1);
});
