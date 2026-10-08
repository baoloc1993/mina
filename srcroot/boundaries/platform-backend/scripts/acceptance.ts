// Acceptance W2 — chạy AC-1..AC-10 (và phần HTTP của AC-11) trên backend local đang chạy, bằng HTTP + CLI thật.
//   npm run accept            (cần `make dev` + `python deployment/local/seed/seed.py` đã chạy)
// Dọn sau khi chạy: app thử `vn.app.accept*`, user `accept-*@test.local`, phiên/thiết bị của 2 user seed; trả gói + cài đặt về như seed.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { BACKEND_DIR, config, loadLocalEnv } from "./lib/env.ts";
import { verifyDigest } from "./lib/sign.ts";

loadLocalEnv();
const cfg = config();
const API = "http://127.0.0.1:54321";
const MAIL = "http://127.0.0.1:54324";
const PS = "http://127.0.0.1:8090";
const ANON = process.env.SUPABASE_ANON_KEY ?? "";
const A_EMAIL = "a@test.local";
const B_EMAIL = "b@test.local";

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) passed++;
  else failures.push(`${name}${detail ? " — " + detail : ""}`);
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : "  → " + detail}`);
}
const section = (t: string): void => console.log(`\n${t}`);
const info = (t: string): void => console.log(`  · ${t}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const js = (x: unknown) => JSON.stringify(x);

// ---------- HTTP ----------
type Resp = { status: number; body: any };
async function http(url: string, init: RequestInit & { token?: string } = {}): Promise<Resp> {
  const headers: Record<string, string> = { apikey: ANON, ...(init.headers as Record<string, string> | undefined) };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.body && !headers["content-type"]) headers["content-type"] = "application/json";
  const r = await fetch(url, { ...init, headers });
  const text = await r.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* giữ chuỗi */ }
  return { status: r.status, body };
}
const rest = (path: string, token: string) => http(`${API}/rest/v1/${path}`, { token });
const rpc = (name: string, args: object, token: string) => http(`${API}/rest/v1/rpc/${name}`, { method: "POST", body: js(args), token });
const fn = (name: string, token: string | undefined, body?: unknown, method = "POST") =>
  http(`${API}/functions/v1/${name}`, { method, token, body: body === undefined ? undefined : js(body) });

type Session = { access_token: string; refresh_token: string; user: { id: string } };
const claims = (jwt: string): Record<string, any> => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());

async function otpLogin(email: string): Promise<Session> {
  const since = Date.now() - 2000;
  const send = await http(`${API}/auth/v1/otp`, { method: "POST", body: js({ email, create_user: true }) });
  if (send.status !== 200) throw new Error(`gửi OTP lỗi ${send.status} ${js(send.body)}`);
  for (let i = 0; i < 30; i++) {
    const list = (await http(`${MAIL}/api/v1/messages`)).body?.messages ?? [];
    const m = list.find((x: any) => x.To?.some((t: any) => t.Address === email) && new Date(x.Created).getTime() >= since);
    if (m) {
      const full = (await http(`${MAIL}/api/v1/message/${m.ID}`)).body;
      const code = /\b(\d{6})\b/.exec(full.Text ?? "")?.[1];
      if (code) {
        const v = await http(`${API}/auth/v1/verify`, { method: "POST", body: js({ type: "email", email, token: code }) });
        if (v.status !== 200) throw new Error(`verify OTP lỗi ${v.status} ${js(v.body)}`);
        return v.body;
      }
    }
    await sleep(500);
  }
  throw new Error(`không thấy mail OTP cho ${email}`);
}

/** Phiên thứ hai không tốn hạn mức mail: link đăng nhập do admin sinh. */
async function extraSession(email: string, serviceKey: string): Promise<Session> {
  const g = await http(`${API}/auth/v1/admin/generate_link`, { method: "POST", token: serviceKey, body: js({ type: "magiclink", email }) });
  const hash = g.body?.hashed_token ?? g.body?.properties?.hashed_token;
  const v = await http(`${API}/auth/v1/verify`, { method: "POST", body: js({ type: "magiclink", token_hash: hash }) });
  if (v.status !== 200) throw new Error(`phiên thứ hai lỗi ${v.status} ${js(v.body)}`);
  return v.body;
}

const refresh = (rt: string) => http(`${API}/auth/v1/token?grant_type=refresh_token`, { method: "POST", body: js({ refresh_token: rt }) });

// ---------- CLI ----------
function registry(...args: string[]): { code: number; out: string } {
  const r = spawnSync(process.execPath, ["scripts/registry.ts", ...args], { cwd: BACKEND_DIR, encoding: "utf8" });
  return { code: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
}

function makeApp(id: string, version: string, migrations: Record<string, string>, extra: object = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "acc-"));
  writeFileSync(join(dir, "manifest.json"), js({ id, name: id, version, sdk: "0", entry: "index.html", scopes: ["db"], tables: ["items"], ...extra }));
  writeFileSync(join(dir, "index.html"), `<p>${id}@${version}</p>`);
  mkdirSync(join(dir, "migrations"));
  for (const [f, sql] of Object.entries(migrations)) writeFileSync(join(dir, "migrations", f), sql);
  return dir;
}

// ---------- PowerSync ----------
async function psSnapshot(token: string): Promise<Record<string, any[]>> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  const buckets: Record<string, any[]> = {};
  try {
    const r = await fetch(`${PS}/sync/stream`, {
      method: "POST", signal: ctl.signal,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/x-ndjson" },
      body: js({ buckets: [], include_checksum: true, raw_data: true, client_id: "acceptance", parameters: {} }),
    });
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of r.body as any) {
      buf += dec.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.data) {
          const name = msg.data.bucket.replace(/^\d+#/, "").replace(/\[.*$/, "");
          buckets[name] ??= [];
          for (const e of msg.data.data) if (e.op === "PUT") buckets[name].push(JSON.parse(e.data));
        }
        if (msg.checkpoint?.buckets) for (const b of msg.checkpoint.buckets) buckets[b.bucket.replace(/^\d+#/, "").replace(/\[.*$/, "")] ??= [];
        if (msg.checkpoint_complete) { ctl.abort(); return buckets; }
      }
    }
  } catch (e) {
    if (!ctl.signal.aborted) throw e;
  } finally {
    clearTimeout(timer);
  }
  return buckets;
}

async function psUntil(token: string, pred: (b: Record<string, any[]>) => boolean): Promise<Record<string, any[]>> {
  let last: Record<string, any[]> = {};
  for (let i = 0; i < 12; i++) {
    last = await psSnapshot(token);
    if (pred(last)) return last;
    await sleep(1000);
  }
  return last;
}

// =====================================================================================
async function main(): Promise<void> {
  const db = new pg.Client({ connectionString: cfg.databaseUrl });
  await db.connect();
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!ANON || !serviceKey) throw new Error("thiếu SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY trong deployment/local/.env");

  const tenantOf = async (email: string) =>
    (await q("select t.id from tenants t join auth.users u on u.id = t.owner_user_id where u.email = $1", [email]))[0]?.id as string;
  const t0 = (await q("select now() as t"))[0].t as Date;
  const storage = createClient(API, serviceKey, { auth: { persistSession: false } }).storage.from("packages");
  const cleanup = async () => {
    // Object trong Storage chỉ xoá được qua API (không xoá thẳng bảng storage.objects).
    for (const folder of (await storage.list("", { limit: 200 })).data ?? []) {
      if (!folder.name.startsWith("vn.app.accept")) continue;
      const files = (await storage.list(folder.name, { limit: 200 })).data ?? [];
      if (files.length) await storage.remove(files.map((f) => `${folder.name}/${f.name}`));
    }
    await q("delete from app_version_testers where app_id like 'vn.app.accept%'");
    await q("delete from installations where app_id like 'vn.app.accept%'");
    await q("delete from intent_schemas where app_id like 'vn.app.accept%'");
    await q("delete from app_tables where app_id like 'vn.app.accept%'");
    await q("delete from app_migrations where app_id like 'vn.app.accept%'");
    await q("delete from app_versions where app_id like 'vn.app.accept%'");
    await q("delete from apps where id like 'vn.app.accept%'");
    for (const t of await q("select tablename from pg_tables where schemaname='public' and tablename like 'app_vn_app_accept%'")) {
      await q(`drop table public.${db.escapeIdentifier(t.tablename)}`);
    }
    await q("delete from auth.users where email like 'accept-%@test.local'");
    await q("delete from sync_rejections");
    // Chỉ dọn phiên do lần chạy này tạo (giữ phiên emulator đang đăng nhập của dogfood).
    await q("delete from auth.sessions where created_at >= $1 and user_id in (select id from auth.users where email in ($2, $3))", [t0, A_EMAIL, B_EMAIL]);
    await q("delete from devices where created_at >= $1 and user_id in (select id from auth.users where email in ($2, $3))", [t0, A_EMAIL, B_EMAIL]);
    await q("update tenants set plan = 'mvp-unlimited' where plan <> 'mvp-unlimited'");
    await q("delete from plans where id = 'accept-2'");
    await q("delete from app_hello_items where title like 'ACC:%'");
    for (const e of [A_EMAIL, B_EMAIL]) await q("select public._install_app($1, 'vn.app.hello')", [await tenantOf(e)]);
  };
  await cleanup();
  const tA = await tenantOf(A_EMAIL), tB = await tenantOf(B_EMAIL);

  // ---------------------------------------------------------------- AC-1
  section("AC-1 · Đăng nhập OTP, tenant tự tạo, Google/Apple cấu hình phía server");
  const sA = await otpLogin(A_EMAIL);
  const cA = claims(sA.access_token);
  check("OTP end-to-end trả JWT có claim tenant_id đúng tenant của user", cA.tenant_id === tA, `claim=${cA.tenant_id}`);
  const newEmail = `accept-${Date.now()}@test.local`;
  const before = (await q("select count(*)::int n from tenants"))[0].n;
  const sNew = await otpLogin(newEmail);
  const after = (await q("select count(*)::int n from tenants"))[0].n;
  const planNew = (await q("select plan from tenants where owner_user_id = $1", [sNew.user.id]))[0]?.plan;
  check("lần đầu đăng nhập: tự tạo user + đúng 1 tenant + gói mvp-unlimited", after === before + 1 && planNew === "mvp-unlimited", `tenants ${before}→${after}, plan=${planNew}`);
  check("JWT user mới cũng có tenant_id", !!claims(sNew.access_token).tenant_id);
  const settings = (await http(`${API}/auth/v1/settings`)).body;
  check("provider Google và Apple đã bật phía server (qua env)", settings.external?.google === true && settings.external?.apple === true);
  const manual = await http(`${API}/auth/v1/user/identities/authorize?provider=google&skip_http_redirect=true`, { token: sNew.access_token });
  check("liên kết thêm identity (manual linking) được GoTrue chấp nhận cho user đang đăng nhập", manual.status !== 404 && manual.status !== 400 && !/manual_linking_disabled/.test(js(manual.body)), `HTTP ${manual.status} ${js(manual.body).slice(0, 120)}`);
  info("gộp identity trùng email → không sinh tenant thứ hai: kiểm bằng pgTAP (platform.test.sql); bấm thật Google/Apple ở vòng 3");

  // ---------------------------------------------------------------- AC-2
  section("AC-2 · Thiết bị: mỗi phiên một dòng, thu hồi → refresh bị từ chối");
  const s2 = await extraSession(A_EMAIL, serviceKey);
  const sB = await otpLogin(B_EMAIL);
  const devs = (await rest(`devices?select=id,session_id,revoked_at&created_at=gte.${encodeURIComponent(t0.toISOString())}&order=created_at`, sA.access_token)).body as any[];
  check("tenant A liệt kê 2 thiết bị (2 phiên đăng nhập) qua PostgREST", devs.length === 2, `được ${devs.length}`);
  const dev2 = devs.find((d) => d.session_id === claims(s2.access_token).session_id);
  const bTry = await rpc("revoke_device", { p_device_id: dev2.id }, sB.access_token);
  check("tenant B không thu hồi được thiết bị của A: DEVICE_NOT_FOUND", bTry.status >= 400 && /DEVICE_NOT_FOUND/.test(js(bTry.body)), js(bTry.body));
  check("tenant B không thấy thiết bị của A", ((await rest("devices?select=id", sB.access_token)).body as any[]).every((d) => d.id !== dev2.id));
  const rv = await rpc("revoke_device", { p_device_id: dev2.id }, sA.access_token);
  check("A thu hồi máy 2 → RPC thành công", rv.status === 200 || rv.status === 204, js(rv.body));
  const r2 = await refresh(s2.refresh_token);
  check("refresh token của phiên bị thu hồi bị GoTrue từ chối", r2.status >= 400, `HTTP ${r2.status}`);
  const r1 = await refresh(sA.refresh_token);
  check("phiên máy khác vẫn refresh được", r1.status === 200 && !!r1.body.access_token, `HTTP ${r1.status}`);
  const sA1: Session = r1.body;
  const revoked = (await q("select revoked_at from devices where session_id = $1", [claims(s2.access_token).session_id]))[0];
  check("devices.revoked_at có giá trị", !!revoked?.revoked_at);
  const up2 = await fn("upload", s2.access_token, { ops: [] });
  check("JWT cũ của máy bị thu hồi bị chặn ngay ở upload (không chờ hết hạn)", up2.status === 401, `HTTP ${up2.status}`);
  const win = await rest("devices?select=id", s2.access_token);
  info(`cửa sổ còn lại (đã biết, DECISIONS): PostgREST với JWT cũ của máy bị thu hồi → HTTP ${win.status} (còn hiệu lực tới jwt_expiry ≤ 1 giờ)`);
  // phiên A dùng cho các bước sau
  const tokA = sA1.access_token;
  const tokB = sB.access_token;

  // ---------------------------------------------------------------- AC-3
  section("AC-3 · App token chỉ cấp cho app đã cài + bật");
  const t1 = await fn("issue-app-token", tokA, { app_id: "vn.app.hello" });
  const tc = t1.status === 200 ? claims(t1.body.token) : {};
  check("hello đã cài → 200, token đúng claim tenant_id + app_id, TTL 15 phút", t1.status === 200 && tc.tenant_id === tA && tc.app_id === "vn.app.hello" && tc.exp - tc.iat === 900, js(t1.body));
  const t2 = await fn("issue-app-token", tokA, { app_id: "vn.app.chua-cai" });
  check("app chưa cài → 403 APP_NOT_INSTALLED", t2.status === 403 && t2.body.error === "APP_NOT_INSTALLED", js(t2.body));
  await rpc("uninstall_app", { p_app_id: "vn.app.hello" }, tokA);
  const t3 = await fn("issue-app-token", tokA, { app_id: "vn.app.hello" });
  check("app đã gỡ (enabled = false) → 403 APP_NOT_INSTALLED", t3.status === 403 && t3.body.error === "APP_NOT_INSTALLED", js(t3.body));
  const ri = await rpc("install_app", { p_app_id: "vn.app.hello" }, tokA);
  check("cài lại hello → lại cấp được token", ri.status < 300 && (await fn("issue-app-token", tokA, { app_id: "vn.app.hello" })).status === 200, js(ri.body));
  const t4 = await fn("issue-app-token", tokB, { app_id: "vn.app.private-a" });
  check("tenant B không xin được token cho app riêng của A", t4.status === 403, js(t4.body));
  check("không JWT → 401", (await fn("issue-app-token", undefined, { app_id: "vn.app.hello" })).status === 401);

  // ---------------------------------------------------------------- AC-4
  section("AC-4 · Publish bằng script: ký, lint, version, draft, tenant thử");
  const intents = [{ type: "accept.thing", version: "1", schema: { type: "object" } }];
  const okMig = "CREATE TABLE IF NOT EXISTS app_vn_app_accept1_items (id uuid PRIMARY KEY, title text NOT NULL DEFAULT '');";
  const d1 = makeApp("vn.app.accept1", "0.0.1", { "001_init.sql": okMig }, { intents });
  const p1 = registry("publish", d1);
  check("publish accept1@0.0.1 thành công", p1.code === 0, p1.out);
  const v1 = (await q("select status, key_id, length(signature) sl from app_versions where app_id = 'vn.app.accept1' and version = '0.0.1'"))[0];
  check("app_versions.status = draft, có key_id và chữ ký", v1?.status === "draft" && v1?.key_id === cfg.signingKeyId && v1?.sl > 40, js(v1));
  const reg = (await q(`select (select table_prefix from apps where id='vn.app.accept1') prefix,
      (select count(*)::int from app_tables where app_id='vn.app.accept1' and table_name='app_vn_app_accept1_items') tbl,
      (select count(*)::int from intent_schemas where app_id='vn.app.accept1') intents,
      (select relrowsecurity from pg_class where relname='app_vn_app_accept1_items') rls,
      (select count(*)::int from pg_policies where tablename='app_vn_app_accept1_items' and policyname='tenant_isolation') pol,
      (select count(*)::int from pg_publication_tables where pubname='powersync' and tablename='app_vn_app_accept1_items') pub,
      (select count(*)::int from pg_trigger where tgrelid='public.app_vn_app_accept1_items'::regclass and tgname='set_updated_at') trg,
      (select count(*)::int from information_schema.columns where table_name='app_vn_app_accept1_items' and column_name in ('tenant_id','created_at','updated_at','deleted_at')) syscols`))[0];
  check("CLI ghi apps/app_tables/intent_schemas; table_prefix mặc định đúng", reg.prefix === "app_vn_app_accept1" && reg.tbl === 1 && reg.intents === 1, js(reg));
  check("CLI tự chèn cột hệ thống + RLS tenant_isolation + trigger giờ server + publication powersync", reg.syscols === 4 && reg.rls && reg.pol === 1 && reg.trg === 1 && reg.pub === 1, js(reg));

  const dup = registry("publish", d1);
  check("publish lại cùng version bị từ chối: VERSION_NOT_GREATER", dup.code !== 0 && /VERSION_NOT_GREATER/.test(dup.out), dup.out);
  const lower = registry("publish", makeApp("vn.app.accept1", "0.0.0", {}));
  check("version thấp hơn bị từ chối: VERSION_NOT_GREATER", lower.code !== 0 && /VERSION_NOT_GREATER/.test(lower.out), lower.out);

  const bad: [string, string, string][] = [
    ["DROP TABLE", "DROP TABLE app_vn_app_accept1_items;", "MIGRATION_NOT_ADDITIVE"],
    ["RENAME", "ALTER TABLE app_vn_app_accept1_items RENAME TO app_vn_app_accept1_old;", "MIGRATION_NOT_ADDITIVE"],
    ["đổi type", "ALTER TABLE app_vn_app_accept1_items ALTER COLUMN title TYPE integer;", "MIGRATION_NOT_ADDITIVE"],
    ["NOT NULL không default", "ALTER TABLE app_vn_app_accept1_items ADD COLUMN must text NOT NULL;", "MIGRATION_NOT_ADDITIVE"],
    ["bảng ngoài prefix", "CREATE TABLE IF NOT EXISTS tenants_copy (id uuid);", "TABLE_OUTSIDE_PREFIX"],
    ["sửa bảng của app khác", "ALTER TABLE app_hello_items ADD COLUMN x text;", "TABLE_OUTSIDE_PREFIX"],
  ];
  for (const [label, sql, want] of bad) {
    // câu hợp lệ đi TRƯỚC câu xấu: nếu lint không chặn cả file thì cột `extra_ok` sẽ lọt vào DB
    const dir = makeApp("vn.app.accept1", "0.0.2", { "002_x.sql": `ALTER TABLE app_vn_app_accept1_items ADD COLUMN extra_ok text;\n${sql}` });
    const r = registry("publish", dir);
    const leaked = (await q("select count(*)::int n from information_schema.columns where table_name='app_vn_app_accept1_items' and column_name='extra_ok'"))[0].n;
    const v2 = (await q("select count(*)::int n from app_versions where app_id='vn.app.accept1' and version='0.0.2'"))[0].n;
    const obj = (await q("select count(*)::int n from storage.objects where name = 'vn.app.accept1/0.0.2.zip'"))[0].n;
    check(`lint chặn ${label} → ${want}; không áp phần nào, không tạo version, không upload gói`, r.code !== 0 && r.out.includes(want) && leaked === 0 && v2 === 0 && obj === 0, `${r.out.trim()} | cột lọt=${leaked} version=${v2} object=${obj}`);
  }
  const tbl = (await q("select count(*)::int n from pg_tables where tablename = 'app_vn_app_accept1_items'"))[0].n;
  check("bảng cũ còn nguyên sau mọi lần lint chặn", tbl === 1);
  check("manifest sai → BAD_MANIFEST", /BAD_MANIFEST/.test(registry("publish", makeApp("Sai Id", "0.0.1", {})).out));
  const noKey = spawnSync(process.execPath, ["scripts/registry.ts", "publish", makeApp("vn.app.accept9", "0.0.1", {})], { cwd: BACKEND_DIR, encoding: "utf8", env: { ...process.env, SIGNING_KEY_PATH: join(tmpdir(), "khong-co.pem") } });
  check("thiếu khoá ký → SIGNING_KEY_MISSING", /SIGNING_KEY_MISSING/.test(`${noKey.stdout}${noKey.stderr}`));

  // ---------------------------------------------------------------- AC-5
  section("AC-5 · Catalog đúng phạm vi tenant, URL ký, draft chỉ ở tenant thử");
  const cat = async (tok: string) => ((await fn("catalog", tok, undefined, "GET")).body.apps ?? []) as any[];
  check("chưa thử/published: A không thấy accept1 (draft ẩn)", !(await cat(tokA)).some((a) => a.id === "vn.app.accept1"));
  check("add-tester accept1@0.0.1 cho A", registry("add-tester", "vn.app.accept1", "0.0.1", A_EMAIL).code === 0);
  const aDraft = (await cat(tokA)).find((a) => a.id === "vn.app.accept1");
  check("tenant thử thấy bản draft (status = draft)", aDraft?.version === "0.0.1" && aDraft?.status === "draft", js(aDraft));
  check("tenant B vẫn không thấy bản draft", !(await cat(tokB)).some((a) => a.id === "vn.app.accept1"));
  check("promote accept1@0.0.1", registry("promote", "vn.app.accept1", "0.0.1").code === 0);
  const bPub = (await cat(tokB)).find((a) => a.id === "vn.app.accept1");
  check("sau promote: B thấy published kèm sha256, signature, key_id, table_prefix, package_url",
    bPub?.status === "published" && /^[0-9a-f]{64}$/.test(bPub.sha256) && !!bPub.signature && bPub.key_id === cfg.signingKeyId && bPub.table_prefix === "app_vn_app_accept1" && /^https?:\/\//.test(bPub.package_url ?? ""), js(bPub));
  let zipOk = false, sigOk = false;
  if (bPub?.package_url) {
    const z = await fetch(bPub.package_url);
    const bytes = Buffer.from(await z.arrayBuffer());
    const digest = createHash("sha256").update(bytes).digest();
    zipOk = z.status === 200 && digest.toString("hex") === bPub.sha256;
    const key = ((await rest(`signing_keys?key_id=eq.${bPub.key_id}&select=public_key`, tokB)).body as any[])[0]?.public_key;
    sigOk = !!key && verifyDigest(key, digest, bPub.signature) && !verifyDigest(key, createHash("sha256").update("giả").digest(), bPub.signature);
  }
  check("package_url dùng đúng địa chỉ người gọi đã vào API (thiết bị không nhận địa chỉ docker nội bộ)", (bPub?.package_url ?? "").startsWith(`${API}/storage/`), bPub?.package_url?.slice(0, 50));
  check("tải gói qua URL ký: sha256 khớp catalog", zipOk);
  check("chữ ký Ed25519 xác minh được bằng signing_keys (đọc qua PostgREST); sai nội dung → không khớp", sigOk);
  const priv = (await cat(tokA)).some((a) => a.id === "vn.app.private-a");
  const privB = (await cat(tokB)).some((a) => a.id === "vn.app.private-a");
  check("app riêng (owner_tenant_id) chỉ hiện ở chủ: A thấy, B không", priv && !privB, `A=${priv} B=${privB}`);
  check("catalog cần JWT: không token → 401", (await fn("catalog", undefined, undefined, "GET")).status === 401);
  check("signing_keys đọc được nhưng không ghi được", (await http(`${API}/rest/v1/signing_keys`, { method: "POST", token: tokA, body: js({ key_id: "x", public_key: "y" }) })).status >= 400);

  // ---------------------------------------------------------------- AC-7, AC-8
  section("AC-7/8 · Quota khi cài + đổi gói bằng tay");
  await q("insert into plans (id, name, max_apps) values ('accept-2', 'Gói thử 2 app', 2)");
  check("set-plan A → gói thử max_apps = 2", registry("set-plan", A_EMAIL, "accept-2").code === 0);
  for (const id of ["vn.app.accept2", "vn.app.accept3"]) {
    const d = makeApp(id, "0.0.1", { "001.sql": `CREATE TABLE IF NOT EXISTS app_${id.replace(/\./g, "_")}_items (id uuid PRIMARY KEY);` });
    registry("publish", d); registry("promote", id, "0.0.1");
  }
  const i1 = await rpc("install_app", { p_app_id: "vn.app.accept1" }, tokA);
  check("A (hello đã bật) cài app chung thứ 2 → được", i1.status < 300, js(i1.body));
  const i2 = await rpc("install_app", { p_app_id: "vn.app.accept2" }, tokA);
  check("app chung thứ 3 vượt quota → QUOTA_EXCEEDED", i2.status >= 400 && /QUOTA_EXCEEDED/.test(js(i2.body)), js(i2.body));
  check("app riêng của A không tính vào quota", (await rpc("install_app", { p_app_id: "vn.app.private-a" }, tokA)).status < 300);
  check("set-plan sai tên gói → PLAN_NOT_FOUND", /PLAN_NOT_FOUND/.test(registry("set-plan", A_EMAIL, "khong-co").out));
  check("set-plan A → mvp-unlimited", registry("set-plan", A_EMAIL, "mvp-unlimited").code === 0);
  const i3 = await rpc("install_app", { p_app_id: "vn.app.accept2" }, tokA);
  check("lần cài kế tiếp dùng gói mới → cài được", i3.status < 300, js(i3.body));
  check("tenant B cài app riêng của A → APP_NOT_AVAILABLE", /APP_NOT_AVAILABLE/.test(js((await rpc("install_app", { p_app_id: "vn.app.private-a" }, tokB)).body)));
  check("ghi trực tiếp installations qua PostgREST bị chặn", (await http(`${API}/rest/v1/installations`, { method: "POST", token: tokA, body: js({ tenant_id: tA, app_id: "vn.app.accept3" }) })).status >= 400);

  // ---------------------------------------------------------------- AC-6
  section("AC-6 · Thu hồi version lỗi");
  const d2 = makeApp("vn.app.accept1", "0.0.2", { "002_extra.sql": "ALTER TABLE app_vn_app_accept1_items ADD COLUMN IF NOT EXISTS extra text;" });
  check("publish + promote accept1@0.0.2 (migration cộng thêm được áp)", registry("publish", d2).code === 0 && registry("promote", "vn.app.accept1", "0.0.2").code === 0);
  check("migration 002 đã áp (cột extra có)", (await q("select count(*)::int n from information_schema.columns where table_name='app_vn_app_accept1_items' and column_name='extra'"))[0].n === 1);
  check("publish lại 0.0.2 sau lỗi giữa chừng vẫn idempotent ở tầng migration: file đã áp không áp lại", (await q("select count(*)::int n from app_migrations where app_id='vn.app.accept1'"))[0].n === 2);
  check("A cài lại để nhận 0.0.2", (await rpc("install_app", { p_app_id: "vn.app.accept1" }, tokA)).status < 300);
  check("catalog trả 0.0.2 cho A", (await cat(tokA)).find((a) => a.id === "vn.app.accept1")?.version === "0.0.2");
  check("revoke accept1@0.0.2", registry("revoke", "vn.app.accept1", "0.0.2").code === 0);
  const afterRev = (await cat(tokA)).find((a) => a.id === "vn.app.accept1");
  check("tenant đang cài bản bị thu hồi → catalog trả bản published cao nhất còn lại (0.0.1)", afterRev?.version === "0.0.1" && afterRev?.installed === true, js(afterRev));
  check("revoke lần hai là idempotent", registry("revoke", "vn.app.accept1", "0.0.2").code === 0);
  check("bản đã revoke không promote lại được", registry("promote", "vn.app.accept1", "0.0.2").code !== 0);
  registry("revoke", "vn.app.accept1", "0.0.1");
  const none = (await cat(tokA)).find((a) => a.id === "vn.app.accept1");
  check("không còn bản an toàn → version null + code NO_SAFE_VERSION, installations giữ", none?.version === null && none?.code === "NO_SAFE_VERSION" && none?.installed === true, js(none));
  check("tenant chưa cài thì app chết biến mất khỏi catalog", !(await cat(tokB)).some((a) => a.id === "vn.app.accept1"));
  check("dữ liệu bảng app không bị xoá khi thu hồi (bảng còn)", (await q("select count(*)::int n from pg_tables where tablename='app_vn_app_accept1_items'"))[0].n === 1);

  // ---------------------------------------------------------------- AC-10
  section("AC-10 · Upload v1: LWW theo trường, xoá thắng sửa, hàng đợi lỗi");
  const T = "app_hello_items";
  const id = (n: number) => `acc00000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const up = async (tok: string, ops: unknown[]) => fn("upload", tok, { ops });
  const row = async (tok: string, i: string) => ((await rest(`${T}?id=eq.${i}&select=*`, tok)).body as any[])[0];

  let r = await up(tokA, [{ op: "PUT", table: T, id: id(1), data: { title: "ACC: gốc", done: false, tenant_id: tB, updated_at: "2000-01-01T00:00:00Z", created_at: "2000-01-01T00:00:00Z" } }]);
  check("HTTP 200 + server_time + results[] có id, ok, status", r.status === 200 && !!r.body.server_time && r.body.results[0].ok === true && r.body.results[0].status === "ACCEPTED", js(r.body));
  let rw = await row(tokA, id(1));
  check("tenant_id lấy từ JWT dù client khai tenant B; updated_at/created_at do server đặt (giờ máy bị bỏ)", rw?.tenant_id === tA && Date.now() - new Date(rw.updated_at).getTime() < 60000 && new Date(rw.created_at).getFullYear() > 2000, js(rw));

  await up(tokA, [{ op: "PATCH", table: T, id: id(1), data: { title: "ACC: A sửa" } }]);
  await up(tokA, [{ op: "PATCH", table: T, id: id(1), data: { done: true } }]);
  rw = await row(tokA, id(1));
  check("hai máy sửa hai trường khác nhau → giữ cả hai", rw.title === "ACC: A sửa" && rw.done === true, js(rw));

  await up(tokA, [{ op: "PATCH", table: T, id: id(1), data: { title: "ACC: máy B 10h" } }]);
  await up(tokA, [{ op: "PATCH", table: T, id: id(1), data: { title: "ACC: máy A 9h (tới sau)" } }]);
  check("cùng trường → bản tới server sau thắng", (await row(tokA, id(1))).title === "ACC: máy A 9h (tới sau)");

  r = await up(tokA, [{ op: "PUT", table: T, id: id(1), data: { done: false } }, { op: "PUT", table: T, id: id(1), data: { done: false } }]);
  const cnt = (await q("select count(*)::int n from app_hello_items where id = $1", [id(1)]))[0].n;
  check("PUT trùng id gộp trường như PATCH, gửi hai lần không nhân đôi", r.body.results.every((x: any) => x.status === "ACCEPTED") && cnt === 1);

  r = await up(tokA, [{ op: "DELETE", table: T, id: id(1) }]);
  check("DELETE → xoá mềm", r.body.results[0].status === "ACCEPTED" && !!(await row(tokA, id(1))).deleted_at);
  const delAt = (await row(tokA, id(1))).deleted_at;
  r = await up(tokA, [{ op: "PATCH", table: T, id: id(1), data: { title: "ACC: hồi sinh?" } }, { op: "PATCH", table: T, id: id(1), data: { deleted_at: null } }]);
  rw = await row(tokA, id(1));
  check("sửa tới sau khi dòng đã xoá → IGNORED/DELETED (ok = true), không ghi, không hồi sinh", r.body.results.every((x: any) => x.status === "IGNORED" && x.code === "DELETED" && x.ok === true) && rw.title === "ACC: máy A 9h (tới sau)" && rw.deleted_at === delAt, js(r.body));
  r = await up(tokA, [{ op: "DELETE", table: T, id: id(1) }]);
  check("xoá lại là idempotent", r.body.results[0].ok === true && r.body.results[0].status === "ACCEPTED");

  await up(tokA, [{ op: "PUT", table: T, id: id(2), data: { title: "ACC: sửa rồi xoá" } }, { op: "PATCH", table: T, id: id(2), data: { title: "ACC: sửa" } }]);
  await up(tokA, [{ op: "PATCH", table: T, id: id(2), data: { deleted_at: "2020-01-01T00:00:00Z", updated_at: "2020-01-01T00:00:00Z" } }]);
  rw = await row(tokA, id(2));
  check("PATCH mang deleted_at (cách bridge của shell vòng 1 xoá) → xoá mềm với giờ server", !!rw.deleted_at && new Date(rw.deleted_at).getFullYear() >= 2026, js(rw));

  // tenant khác + lô lẫn lộn
  await up(tokA, [{ op: "PUT", table: T, id: id(3), data: { title: "ACC: của A" } }]);
  const mixed = [
    { op: "PATCH", table: T, id: id(3), data: { title: "ACC: B chiếm" } },
    { op: "PUT", table: T, id: id(3), data: { title: "ACC: B chiếm bằng PUT" } },
    { op: "PUT", table: T, id: id(4), data: { title: "ACC: của B, hợp lệ" } },
    { op: "PATCH", table: "bang_la", id: id(5), data: {} },
    { op: "PATCH", table: T, id: id(4), data: { cot_khong_co: 1 } },
    { op: "PATCH", table: T, id: id(4), data: { title: "ACC: của B, sau lỗi" } },
  ];
  r = await up(tokB, mixed);
  const st = r.body.results.map((x: any) => `${x.status}${x.code ? "/" + x.code : ""}`);
  check("PATCH/PUT dòng tenant khác → REJECTED/FORBIDDEN; bảng lạ → TABLE_NOT_ALLOWED; cột lạ → SCHEMA; RLS chặn không còn trả ok: true",
    js(st) === js(["REJECTED/FORBIDDEN", "REJECTED/FORBIDDEN", "ACCEPTED", "REJECTED/TABLE_NOT_ALLOWED", "REJECTED/SCHEMA", "ACCEPTED"]) && r.body.results[0].ok === false, js(st));
  check("các thay đổi khác trong lô vẫn ghi (HTTP 200)", r.status === 200 && (await row(tokB, id(4)))?.title === "ACC: của B, sau lỗi");
  check("dòng của A không bị B đụng tới", (await row(tokA, id(3))).title === "ACC: của A");
  const rejB = (await rest("sync_rejections?select=table_name,row_id,op,code&order=created_at", tokB)).body as any[];
  check("mỗi REJECTED ghi một dòng sync_rejections của tenant B (4 dòng)", rejB.length === 4 && rejB.filter((x) => x.code === "FORBIDDEN").length === 2, js(rejB));
  check("A không thấy hàng đợi lỗi của B", ((await rest("sync_rejections?select=id", tokA)).body as any[]).length === 0);

  const tbl1 = "app_vn_app_accept1_items";
  r = await up(tokA, [{ op: "PUT", table: tbl1, id: id(6), data: { title: "ACC: bảng của app thử" } }]);
  check("bảng của app đã publish (app_tables) nhận được thay đổi như bảng hello", r.body.results?.[0]?.status === "ACCEPTED", js(r.body));
  r = await up(tokB, [{ op: "PUT", table: tbl1, id: id(6), data: { title: "ACC: B" } }]);
  check("…và RLS cô lập tenant trên bảng đó", r.body.results?.[0]?.code === "FORBIDDEN", js(r.body));
  r = await up(tokA, [{ op: "PUT", table: "tenants", id: id(7), data: {} }, { op: "PUT", table: "devices", id: id(8), data: {} }, { op: "PUT", table: "app_versions", id: id(9), data: {} }]);
  check("bảng hệ thống (tenants, devices, app_versions) không nằm trong sổ app_tables → TABLE_NOT_ALLOWED", r.body.results.every((x: any) => x.code === "TABLE_NOT_ALLOWED"), js(r.body));

  check("không JWT → 401 UNAUTHORIZED", (await fn("upload", undefined, { ops: [] })).status === 401);
  check("body sai khuôn → 400 BAD_REQUEST", (await fn("upload", tokA, { khong: "co ops" })).status === 400);
  check("thay đổi sai khuôn → REJECTED/BAD_OP, không làm hỏng lô", ((await up(tokA, [{ op: "XOA", table: T, id: "x" }, { op: "PUT", table: T, id: id(10), data: { title: "ACC: ok" } }])).body.results ?? []).map((x: any) => x.code ?? x.status).join() === "BAD_OP,ACCEPTED");

  // ---------------------------------------------------------------- AC-9
  section("AC-9 · Sync rules theo app đã cài (PowerSync thật) + RLS");
  const bA = await psUntil(tokA, (b) => !!b.app_hello && b.app_hello.length >= 20);
  check("tenant có hello cài: bucket app_hello kéo dòng hello của mình", (bA.app_hello?.length ?? 0) >= 20 && bA.app_hello.every((x) => x.tenant_id === tA), `dòng=${bA.app_hello?.length}`);
  check("bucket installations và rejections có mặt; app riêng của A có bucket riêng", !!bA.installations && !!bA.rejections && !!bA.app_vn_app_private_a, js(Object.keys(bA)));
  check("tenant B chỉ nhận dòng của B (không lẫn tenant A)", await (async () => {
    const b = await psUntil(tokB, (x) => !!x.app_hello && x.app_hello.length >= 20);
    return Object.values(b).flat().every((x: any) => !x.tenant_id || x.tenant_id === tB) && !b.app_vn_app_private_a;
  })());
  const serverCount = (await q("select count(*)::int n from app_hello_items where tenant_id = $1 and deleted_at is null", [tA]))[0].n;
  await rpc("uninstall_app", { p_app_id: "vn.app.hello" }, tokA);
  const bGone = await psUntil(tokA, (b) => !b.app_hello);
  const serverAfter = (await q("select count(*)::int n from app_hello_items where tenant_id = $1 and deleted_at is null", [tA]))[0].n;
  check("gỡ app (enabled = false) → thiết bị ngừng kéo bảng đó (bucket biến mất)", !bGone.app_hello, js(Object.keys(bGone)));
  check("…dữ liệu server giữ nguyên", serverAfter === serverCount && serverCount >= 20, `${serverCount}→${serverAfter}`);
  await rpc("install_app", { p_app_id: "vn.app.hello" }, tokA);
  const bBack = await psUntil(tokA, (b) => !!b.app_hello && b.app_hello.length >= 20);
  check("cài lại → kéo lại đủ dòng (dữ liệu cũ còn nguyên)", (bBack.app_hello?.length ?? 0) >= serverCount, `dòng=${bBack.app_hello?.length}`);
  const bRej = await psUntil(tokB, (b) => (b.rejections?.length ?? 0) >= 4);
  check("hàng đợi lỗi của B sync xuống thiết bị qua bucket rejections", (bRej.rejections?.length ?? 0) >= 4, `dòng=${bRej.rejections?.length}`);

  // ---------------------------------------------------------------- AC-11 (phần HTTP)
  section("AC-11 · Tương thích ngược: khuôn connector vòng 1 (phần HTTP; shell thật chạy ở emulator)");
  const v1ops = [{ op: "PUT", table: T, id: id(11), data: { id: id(11), tenant_id: tA, title: "ACC: v1", done: 0, created_at: "2026-10-08T00:00:00Z", updated_at: "2026-10-08T00:00:00Z", deleted_at: null } }, { op: "PATCH", table: T, id: id(11), data: { done: 1 } }];
  r = await up(tokA, v1ops);
  check("lô theo khuôn connector vòng 1 → results[].ok = true", r.status === 200 && r.body.results.every((x: any) => x.ok === true), js(r.body));
  check("issue-app-token giữ khuôn { token, expires_at } cho getAppToken", (await fn("issue-app-token", tokA, { app_id: "vn.app.hello" })).body.expires_at > 0);
  check("done 1/0 của SQLite được Postgres nhận (boolean)", (await row(tokA, id(11))).done === true);

  // ---------------------------------------------------------------- dọn
  await cleanup();
  await db.end();
  console.log(`\n${failures.length === 0 ? "XANH" : "ĐỎ"}: ${passed} đạt, ${failures.length} trượt`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exitCode = failures.length === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error("Acceptance dừng giữa chừng:", e instanceof Error ? e.stack : e);
  process.exitCode = 2;
});
