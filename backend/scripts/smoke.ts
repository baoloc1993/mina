// Smoke test luồng lõi phía server (vòng 7 — gate P2 "smoke test pass"; PRODUCTION-READY nhóm 3). Chạy được ở local VÀ production:
//   npm run smoke                              (local docker: http://127.0.0.1:54321, tài khoản smoke-a/b@test.local)
//   REGISTRY_ENV=prod npm run smoke -- --a <email tenant-test A> --b <email tenant-test B>     (đọc deployment/prod/.env)
// Hai tài khoản THỬ (không phải tài khoản dữ liệu thật của P1). Script tự tạo user bằng admin API (production tắt tự đăng ký),
// chỉ ghi dòng `core_tags` mang tiền tố SMOKE- rồi xoá mềm, KHÔNG đụng dữ liệu khác. Không in khoá/JWT.
import { randomUUID } from "node:crypto";
import { config, isProd, loadLocalEnv } from "./lib/env.ts";

loadLocalEnv();
const cfg = config();
const API = cfg.supabaseUrl.replace(/\/$/, "");
const ANON = process.env.SUPABASE_ANON_KEY ?? "";
const SERVICE = cfg.serviceKey ?? "";
const arg = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const A = arg("--a") ?? "smoke-a@test.local";
const B = arg("--b") ?? "smoke-b@test.local";

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) passed++;
  else failures.push(`${name}${detail ? " — " + detail : ""}`);
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : "  → " + detail}`);
}
const section = (t: string): void => console.log(`\n${t}`);
const js = (x: unknown) => JSON.stringify(x);

type Resp = { status: number; body: any };
async function http(url: string, init: RequestInit & { token?: string } = {}): Promise<Resp> {
  const headers: Record<string, string> = { apikey: ANON, ...(init.headers as Record<string, string> | undefined) };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.body && !headers["content-type"]) headers["content-type"] = "application/json";
  const r = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(30_000) });
  const text = await r.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* giữ chuỗi */ }
  return { status: r.status, body };
}

async function ensureUser(email: string): Promise<void> {
  const r = await http(`${API}/auth/v1/admin/users`, { method: "POST", token: SERVICE, body: js({ email, email_confirm: true }) });
  // 422 email_exists = đã có: đúng ý.
  if (r.status >= 300 && r.status !== 422) throw new Error(`tạo user ${email} lỗi ${r.status}`);
}
async function session(email: string, tries = 3): Promise<string> {
  try {
    const g = await http(`${API}/auth/v1/admin/generate_link`, { method: "POST", token: SERVICE, body: js({ type: "magiclink", email }) });
    const hash = g.body?.hashed_token ?? g.body?.properties?.hashed_token;
    const v = await http(`${API}/auth/v1/verify`, { method: "POST", body: js({ type: "magiclink", token_hash: hash }) });
    if (v.status !== 200) throw new Error(`phiên ${v.status}`);
    return v.body.access_token as string;
  } catch (e) {
    if (tries <= 1) throw e;
    await new Promise((r) => setTimeout(r, 1500));
    return session(email, tries - 1);
  }
}

async function main(): Promise<void> {
  if (!ANON || !SERVICE) throw new Error("thiếu SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY");
  console.log(`smoke ${isProd() ? "PRODUCTION" : "local"} — ${new URL(API).host}`);

  section("1. health");
  const h = await http(`${API}/functions/v1/health`);
  check("GET /health → 200 {ok, db}", h.status === 200 && h.body?.ok === true && h.body?.db === true, js(h.body));

  await ensureUser(A);
  await ensureUser(B);
  const ta = await session(A);
  const tb = await session(B);

  section("2. catalog (A) — có app để cài");
  const cat = await http(`${API}/functions/v1/catalog`, { token: ta });
  const apps: { id: string; version: string | null }[] = Array.isArray(cat.body?.apps) ? cat.body.apps : [];
  check("catalog → 200 và có ít nhất 1 app có bản an toàn", cat.status === 200 && apps.some((x) => x.version), `status ${cat.status}, ${apps.length} app`);
  check("catalog có `server_time` + `entitlement` (shell cần cho ân hạn chỉ đọc)", !!cat.body?.server_time && !!cat.body?.entitlement);
  const unauth = await http(`${API}/functions/v1/catalog`);
  check("catalog không JWT → 401", unauth.status === 401, `status ${unauth.status}`);

  section("3. ghi → đọc lại → cô lập tenant");
  const id = randomUUID();
  const put = await http(`${API}/functions/v1/upload`, { method: "POST", token: ta, body: js({ ops: [{ op: "PUT", table: "core_tags", id, data: { name: "SMOKE-tag" } }] }) });
  check("A: upload PUT core_tags → ACCEPTED", put.status === 200 && put.body?.results?.[0]?.status === "ACCEPTED", js(put.body));
  const readA = await http(`${API}/rest/v1/core_tags?select=id,name&id=eq.${id}`, { token: ta });
  check("A: đọc lại đúng 1 dòng", readA.status === 200 && Array.isArray(readA.body) && readA.body.length === 1 && readA.body[0].name === "SMOKE-tag", js(readA.body));
  const readB = await http(`${API}/rest/v1/core_tags?select=id&id=eq.${id}`, { token: tb });
  check("B: đọc id của A → 0 dòng (RLS)", readB.status === 200 && Array.isArray(readB.body) && readB.body.length === 0, js(readB.body));
  const stealB = await http(`${API}/functions/v1/upload`, { method: "POST", token: tb, body: js({ ops: [{ op: "PATCH", table: "core_tags", id, data: { name: "SMOKE-hijack" } }] }) });
  check("B: upload PATCH id của A → REJECTED FORBIDDEN", stealB.body?.results?.[0]?.status === "REJECTED" && stealB.body?.results?.[0]?.code === "FORBIDDEN", js(stealB.body));
  const still = await http(`${API}/rest/v1/core_tags?select=name&id=eq.${id}`, { token: ta });
  check("dữ liệu của A không đổi sau lần chiếm của B", still.body?.[0]?.name === "SMOKE-tag", js(still.body));

  section("4. cài app + cấp token + đếm ngày dùng");
  const cand = apps.find((x) => x.version && x.id === "vn.app.note") ?? apps.find((x) => x.version);
  if (!cand) {
    check("có app để thử cài", false, "catalog rỗng — publish mini app trước");
  } else {
    const inst = await http(`${API}/rest/v1/rpc/install_app`, { method: "POST", token: ta, body: js({ p_app_id: cand.id }) });
    check(`A: install_app(${cand.id}) → thành công`, inst.status < 300, `status ${inst.status} ${js(inst.body).slice(0, 120)}`);
    const tok = await http(`${API}/functions/v1/issue-app-token`, { method: "POST", token: ta, body: js({ app_id: cand.id }) });
    check("issue-app-token → 200 + token", tok.status === 200 && typeof tok.body?.token === "string", `status ${tok.status}`);
    const opens = await http(`${API}/rest/v1/app_opens_daily?select=app_id,opens&app_id=eq.${cand.id}`, { token: ta });
    check("app_opens_daily có dòng của A cho app vừa mở", opens.status === 200 && Array.isArray(opens.body) && opens.body.length >= 1 && opens.body[0].opens >= 1, js(opens.body));
    const tokB = await http(`${API}/functions/v1/issue-app-token`, { method: "POST", token: tb, body: js({ app_id: cand.id }) });
    check("B (chưa cài) xin token → 403 APP_NOT_INSTALLED", tokB.status === 403, `status ${tokB.status}`);
  }

  section("5. dọn");
  const del = await http(`${API}/functions/v1/upload`, { method: "POST", token: ta, body: js({ ops: [{ op: "DELETE", table: "core_tags", id }] }) });
  check("A: xoá mềm dòng SMOKE-", del.status === 200 && del.body?.results?.[0]?.status !== "REJECTED", js(del.body));

  console.log(`\n${failures.length ? "✗" : "✓"} smoke ${isProd() ? "production" : "local"} — ${passed} kiểm đạt${failures.length ? `, ${failures.length} hỏng` : ""}`);
  if (failures.length) {
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("smoke lỗi:", e instanceof Error ? e.message : e);
  process.exit(1);
});
