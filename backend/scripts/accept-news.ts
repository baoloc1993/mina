// Acceptance W6 (phía server của Đọc báo): catalog trả config, core_net_grants (RLS + upload), trần độ dài bảng Đọc báo, dọn 30 ngày.
//   npm run accept:news     (cần `make dev` + seed: Đọc báo đã publish; bảng chỉ có sau `registry publish`)
// Chưa publish Đọc báo → in thông báo rõ và thoát 0 (SKIP). Chỉ dùng dòng thử (UUID sinh lúc chạy) và dọn sau khi chạy.
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
const SRC = "app_vn_app_news_sources";
const ITM = "app_vn_app_news_items";

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
  const r = await fetch(url, { ...init, headers });
  const text = await r.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* giữ chuỗi */ }
  return { status: r.status, body };
}
async function session(email: string): Promise<string> {
  const g = await http(`${API}/auth/v1/admin/generate_link`, { method: "POST", token: SERVICE, body: js({ type: "magiclink", email }) });
  const hash = g.body?.hashed_token ?? g.body?.properties?.hashed_token;
  const v = await http(`${API}/auth/v1/verify`, { method: "POST", body: js({ type: "magiclink", token_hash: hash }) });
  if (v.status !== 200) throw new Error(`phiên lỗi ${v.status} ${js(v.body)}`);
  return v.body.access_token as string;
}
const rest = (path: string, token: string) => http(`${API}/rest/v1/${path}`, { token });
type Op = { op: "PUT" | "PATCH" | "DELETE"; table: string; id: string; data?: Record<string, unknown> };
const upload = (token: string, ops: Op[]) => http(`${API}/functions/v1/upload`, { method: "POST", token, body: js({ ops }) });
const results = (r: Resp): { status: string; code?: string }[] => r.body?.results ?? [];

const item = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  source_id: "s-acc", guid: "g", title: "ACC: bài thử", summary: "tóm tắt", link: "https://vnexpress.net/a", fetched_at_ms: Date.now(), ...over,
});

async function main(): Promise<void> {
  if (!ANON || !SERVICE) throw new Error("thiếu SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY trong deployment/local/.env");
  const db = new pg.Client({ connectionString: cfg.databaseUrl });
  await db.connect();
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
  const made: string[] = [];
  const uid = () => (made.push(randomUUID()), made[made.length - 1]);
  const cleanup = async () => {
    await q(`delete from ${ITM} where id = any($1)`, [made]).catch(() => undefined);
    await q(`delete from ${SRC} where id = any($1)`, [made]).catch(() => undefined);
    await q("delete from core_net_grants where id = any($1::uuid[])", [made]).catch(() => undefined);
    await q("delete from sync_rejections where row_id = any($1)", [made]).catch(() => undefined);
  };
  try {
    section("Chuẩn bị");
    if (!(await q("select 1 from app_versions where app_id = 'vn.app.news' limit 1")).length || !(await q("select to_regclass($1) as t", [`public.${ITM}`]))[0].t) {
      console.log("  SKIP: Đọc báo chưa publish (chạy `make seed`) — chưa kiểm được phía server của W6.");
      return;
    }
    const ta = await session(A);
    const tb = await session(B);
    check("hai phiên thử (tenant-a, tenant-b)", !!ta && !!tb);

    section("AC-6 catalog trả config (additive)");
    const cat = await http(`${API}/functions/v1/catalog`, { token: ta });
    const news = (cat.body?.apps ?? []).find((a: any) => a.id === "vn.app.news");
    check("catalog 200 và có vn.app.news", cat.status === 200 && !!news);
    check("news.config.sources là mảng ≥ 5 nguồn có feed_url/host", Array.isArray(news?.config?.sources) && news.config.sources.length >= 5 && news.config.sources.every((s: any) => s.feed_url && s.host));
    check("news.config.network là mảng host, gồm vnexpress.net", Array.isArray(news?.config?.network) && news.config.network.includes("vnexpress.net"));
    check("app khác chưa có cấu hình: không có trường config (vắng, không phải null)", !("config" in ((cat.body?.apps ?? []).find((a: any) => a.id === "vn.app.hello") ?? { config: 1 })));
    const direct = await rest("app_configs?select=*", ta);
    check("authenticated KHÔNG đọc trực tiếp app_configs (401/403/[])", direct.status >= 400 || (Array.isArray(direct.body) && direct.body.length === 0), `${direct.status} ${js(direct.body).slice(0, 80)}`);
    const wr = await http(`${API}/rest/v1/app_configs`, { method: "POST", token: ta, body: js({ app_id: "vn.app.news", config: { network: ["evil.example"] } }) });
    check("authenticated KHÔNG ghi được app_configs", wr.status >= 400, `${wr.status}`);

    section("AC-5 core_net_grants: upload + RLS");
    const g1 = uid();
    const up = await upload(ta, [{ op: "PUT", table: "core_net_grants", id: g1, data: { app_id: "vn.app.news", host: "blog.example.dev" } }]);
    check("tenant-a PUT grant → ACCEPTED", results(up)[0]?.status === "ACCEPTED", js(up.body));
    check("tenant-a đọc thấy grant của mình", ((await rest(`core_net_grants?id=eq.${g1}&select=host`, ta)).body ?? []).length === 1);
    check("tenant-b KHÔNG thấy grant của tenant-a", ((await rest(`core_net_grants?id=eq.${g1}&select=host`, tb)).body ?? []).length === 0);
    const bad = uid();
    const upb = await upload(ta, [
      { op: "PUT", table: "core_net_grants", id: bad, data: { app_id: "vn.app.news", host: "*.vn" } },
      { op: "PUT", table: "core_net_grants", id: uid(), data: { app_id: "vn.app.news", host: "https://a.vn" } },
      { op: "PUT", table: "core_net_grants", id: uid(), data: { app_id: "vn.app.news", host: "u:p@a.vn" } },
    ]);
    check("host wildcard / scheme / user:pass@ → REJECTED/SCHEMA cả ba", results(upb).length === 3 && results(upb).every((r) => r.status === "REJECTED" && r.code === "SCHEMA"), js(upb.body));
    const hijack = await upload(tb, [{ op: "PATCH", table: "core_net_grants", id: g1, data: { deleted_at: "x" } }]);
    check("tenant-b không thu hồi được grant của tenant-a (REJECTED/FORBIDDEN hoặc IGNORED)", results(hijack)[0]?.status !== "ACCEPTED", js(hijack.body));
    const rev = await upload(ta, [{ op: "PATCH", table: "core_net_grants", id: g1, data: { deleted_at: "x" } }]);
    check("tenant-a thu hồi = xoá mềm ACCEPTED", results(rev)[0]?.status === "ACCEPTED", js(rev.body));
    check("dòng grant còn trong DB với deleted_at (xoá mềm, không xoá cứng)", (await q("select deleted_at from core_net_grants where id = $1", [g1]))[0]?.deleted_at != null);

    section("Trần độ dài bảng Đọc báo (ensure_news_limits)");
    const sid = uid();
    const ok = await upload(ta, [{ op: "PUT", table: SRC, id: sid, data: { name: "ACC nguồn", feed_url: "https://vnexpress.net/rss", host: "vnexpress.net", position: 0 } }, { op: "PUT", table: ITM, id: uid(), data: item() }]);
    check("nguồn + bài hợp lệ → ACCEPTED", results(ok).length === 2 && results(ok).every((r) => r.status === "ACCEPTED"), js(ok.body));
    const cases: [string, Op][] = [
      ["tiêu đề 301 ký tự", { op: "PUT", table: ITM, id: uid(), data: item({ title: "x".repeat(301) }) }],
      ["tóm tắt 2001 ký tự", { op: "PUT", table: ITM, id: uid(), data: item({ summary: "x".repeat(2001) }) }],
      ["link 2049 ký tự", { op: "PUT", table: ITM, id: uid(), data: item({ link: "https://a.vn/" + "x".repeat(2040) }) }],
      ["note_id không phải UUID", { op: "PUT", table: ITM, id: uid(), data: item({ note_id: "abc" }) }],
      ["saved_at_ms ngoài [0, 2100]", { op: "PUT", table: ITM, id: uid(), data: item({ saved_at_ms: 99999999999999 }) }],
      ["nguồn: tên 101 ký tự", { op: "PUT", table: SRC, id: uid(), data: { name: "x".repeat(101), feed_url: "https://a.vn", host: "a.vn", position: 0 } }],
      ["nguồn: host wildcard", { op: "PUT", table: SRC, id: uid(), data: { name: "n", feed_url: "https://a.vn", host: "*.vn", position: 0 } }],
      ["nguồn: position âm", { op: "PUT", table: SRC, id: uid(), data: { name: "n", feed_url: "https://a.vn", host: "a.vn", position: -1 } }],
    ];
    for (const [name, op] of cases) {
      const r = await upload(ta, [op]);
      check(`${name} → REJECTED/SCHEMA`, results(r)[0]?.status === "REJECTED" && results(r)[0]?.code === "SCHEMA", js(r.body));
    }
    const other = await upload(tb, [{ op: "PATCH", table: ITM, id: made[made.length - 9] ?? sid, data: { title: "chiếm" } }]);
    check("tenant-b không sửa được dòng của tenant-a", results(other)[0]?.status !== "ACCEPTED", js(other.body));

    section("Dọn 30 ngày (purge_news_items)");
    const old = uid();
    const keep = uid();
    await q("set session_replication_role = replica"); // trigger set_updated_at ghi đè updated_at — tắt để dựng dữ liệu "quá khứ"
    await q(`insert into ${ITM} (id, tenant_id, source_id, guid, title, summary, link, fetched_at_ms, saved_at_ms, updated_at)
             select $1::text, t.id, 's', 'g', 't', 's', 'https://a.vn', $3::bigint, null, now() - interval '31 days' from tenants t join auth.users u on u.id = t.owner_user_id where u.email = $4
             union all select $2::text, t.id, 's', 'g2', 't', 's', 'https://a.vn', $3::bigint, 1, now() - interval '31 days' from tenants t join auth.users u on u.id = t.owner_user_id where u.email = $4`,
      [old, keep, Date.now() - 31 * 86_400_000, A]).catch((e) => check("dựng dòng cũ", false, String(e)));
    await q(`update ${ITM} set updated_at = now() - interval '31 days' where id = any($1)`, [[old, keep]]);
    await q("set session_replication_role = origin");
    const purged = Number((await q("select public.purge_news_items() as n"))[0].n);
    check("hàm dọn xoá mềm ≥ 1 bài cũ", purged >= 1, `${purged}`);
    const rows = await q(`select id, deleted_at from ${ITM} where id = any($1)`, [[old, keep]]);
    check("bài cũ chưa lưu bị xoá mềm; bài đọc sau cũ KHÔNG bị dọn", rows.find((r: any) => r.id === old)?.deleted_at != null && rows.find((r: any) => r.id === keep)?.deleted_at == null);
  } finally {
    await cleanup();
    await db.end();
  }
  console.log(`\n${passed} đạt, ${failures.length} trượt`);
  if (failures.length) {
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
