// Acceptance W5 (phía server của Lịch): RLS, trần độ dài / giá trị hợp lệ, xoá thắng sửa, LWW theo trường qua `upload` v1 + PostgREST.
//   npm run accept:calendar     (cần `make dev`; bảng chỉ có sau `registry publish` gói Lịch — seed.py làm việc đó khi có dist/)
// Chưa publish Lịch → in thông báo rõ và thoát 0 (SKIP), không tự dựng bảng. Chỉ dùng dòng thử (UUID sinh lúc chạy) và dọn sau khi chạy.
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
const EV = "app_vn_app_calendar_events";
const OV = "app_vn_app_calendar_event_overrides";

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

/** Dòng events hợp lệ tối thiểu (giờ treo); `over` đè từng trường. */
const evData = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: "event", title: "ACC: Khám răng", all_day: 0, start_local: "2026-10-14T14:00", end_local: "2026-10-14T15:00",
  fixed: 0, repeat_every: 1, repeat_cal: "solar", alert_min: 60, ...over,
});

async function main(): Promise<void> {
  if (!ANON || !SERVICE) throw new Error("thiếu SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY trong deployment/local/.env");
  const db = new pg.Client({ connectionString: cfg.databaseUrl });
  await db.connect();
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
  const made: string[] = [];
  const uid = () => (made.push(randomUUID()), made[made.length - 1]);
  const cleanup = async () => {
    await q(`delete from ${OV} where id = any($1) or event_id = any($1)`, [made]).catch(() => undefined);
    await q(`delete from ${EV} where id = any($1)`, [made]).catch(() => undefined);
    await q("delete from sync_rejections where row_id = any($1)", [made]).catch(() => undefined);
  };
  try {
    section("Chuẩn bị");
    const have = await q("select to_regclass($1) as e, to_regclass($2) as o, (select count(*)::int from app_tables where app_id = 'vn.app.calendar') as n", [`public.${EV}`, `public.${OV}`]);
    if (!have[0].e || !have[0].o || have[0].n < 2) {
      console.log(`  ⚠ SKIP: Lịch (vn.app.calendar) chưa được \`registry publish\` (chưa có 2 bảng events/event_overrides: ${js(have[0])}).`);
      console.log("    Dựng gói Lịch (miniapps/miniapp-calendar/dist) rồi chạy `python deployment/local/seed/seed.py`, sau đó chạy lại.");
      return;
    }
    check("bảng của Lịch đã được dựng (2 bảng trong app_tables)", true);
    await q("select public.ensure_calendar_limits()");
    check("ensure_calendar_limits() đã gắn ràng buộc (events + event_overrides)", (await q("select count(*)::int as n from pg_constraint where conname in ('app_vn_app_calendar_events_limits','app_vn_app_calendar_event_overrides_limits')"))[0].n === 2);
    await cleanup();
    const tokA = await session(A);
    const tokB = await session(B);
    const ids = { e1: uid(), e2: uid(), o1: uid(), merge: uid(), del: uid() };

    section("Ghi / đọc qua upload + PostgREST (tenant A)");
    const put = await upload(tokA, [
      { op: "PUT", table: EV, id: ids.e1, data: evData() },
      { op: "PUT", table: EV, id: ids.e2, data: evData({ kind: "reminder", title: "ACC: Uống thuốc", repeat_unit: "day", alert_min: 0 }) },
      { op: "PUT", table: OV, id: ids.o1, data: { event_id: ids.e2, occ_date: "2026-10-20", action: "skip", patch: "{}" } },
    ]);
    check("A PUT 2 events + 1 event_overrides → ACCEPTED hết", results(put).length === 3 && results(put).every((x) => x.status === "ACCEPTED"), js(put.body));
    const aEv = (await rest(`${EV}?select=id,title,kind&id=in.(${ids.e1},${ids.e2})`, tokA)).body as any[];
    check("A đọc lại đủ 2 events của mình", Array.isArray(aEv) && aEv.length === 2, js(aEv));
    const aOv = (await rest(`${OV}?select=id,action&id=eq.${ids.o1}`, tokA)).body as any[];
    check("A đọc lại event_overrides (action = skip)", aOv?.[0]?.action === "skip", js(aOv));

    section("Trần độ dài / giá trị hợp lệ ở server");
    const longTitle = await upload(tokA, [{ op: "PUT", table: EV, id: uid(), data: evData({ title: "x".repeat(201) }) }]);
    check("title 201 ký tự → REJECTED/SCHEMA", results(longTitle)[0]?.status === "REJECTED" && results(longTitle)[0]?.code === "SCHEMA", js(longTitle.body));
    const okLong = await upload(tokA, [{ op: "PUT", table: EV, id: uid(), data: evData({ title: "x".repeat(200) }) }]);
    check("title đúng 200 ký tự vẫn ACCEPTED (ràng buộc không chặn nhầm)", results(okLong)[0]?.status === "ACCEPTED", js(okLong.body));
    const hourly = await upload(tokA, [{ op: "PUT", table: EV, id: uid(), data: evData({ repeat_unit: "hourly" }) }]);
    check("repeat_unit = 'hourly' → REJECTED", results(hourly)[0]?.status === "REJECTED", js(hourly.body));
    const alert7 = await upload(tokA, [{ op: "PUT", table: EV, id: uid(), data: evData({ alert_min: 7 }) }]);
    check("alert_min = 7 → REJECTED", results(alert7)[0]?.status === "REJECTED", js(alert7.body));
    const badAct = await upload(tokA, [{ op: "PUT", table: OV, id: uid(), data: { event_id: ids.e1, occ_date: "2026-10-14", action: "delete", patch: "{}" } }]);
    check("event_overrides action lạ → REJECTED", results(badAct)[0]?.status === "REJECTED", js(badAct.body));
    const bigPatch = await upload(tokA, [{ op: "PUT", table: OV, id: uid(), data: { event_id: ids.e1, occ_date: "2026-10-14", action: "edit", patch: "p".repeat(4001) } }]);
    check("event_overrides patch 4001 ký tự → REJECTED", results(bigPatch)[0]?.status === "REJECTED", js(bigPatch.body));

    section("RLS: tenant khác không thấy, không ghi được");
    const bEv = await rest(`${EV}?select=id&id=eq.${ids.e1}`, tokB);
    check("B đọc events của A → 0 dòng", Array.isArray(bEv.body) && bEv.body.length === 0, js(bEv.body));
    const bOv = await rest(`${OV}?select=id&id=eq.${ids.o1}`, tokB);
    check("B đọc event_overrides của A → 0 dòng", Array.isArray(bOv.body) && bOv.body.length === 0, js(bOv.body));
    const bPatch = await upload(tokB, [{ op: "PATCH", table: EV, id: ids.e1, data: { title: "ACC: B cố đè" } }]);
    check("B PATCH events của A → REJECTED/FORBIDDEN", results(bPatch)[0]?.status === "REJECTED" && results(bPatch)[0]?.code === "FORBIDDEN", js(bPatch.body));
    check("events của A không đổi sau lần B cố đè", (await q(`select title from ${EV} where id = $1`, [ids.e1]))[0]?.title === "ACC: Khám răng");

    section("Xoá thắng sửa");
    await upload(tokA, [{ op: "PUT", table: EV, id: ids.del, data: evData({ title: "ACC: sẽ xoá" }) }]);
    const del = await upload(tokA, [{ op: "PATCH", table: EV, id: ids.del, data: { deleted_at: new Date().toISOString() } }]);
    check("A xoá mềm events → ACCEPTED", results(del)[0]?.status === "ACCEPTED", js(del.body));
    const late = await upload(tokA, [{ op: "PATCH", table: EV, id: ids.del, data: { title: "ACC: máy offline sửa sau" } }]);
    check("PATCH sau khi đã xoá mềm → IGNORED/DELETED", results(late)[0]?.status === "IGNORED" && results(late)[0]?.code === "DELETED", js(late.body));
    const row = (await q(`select title, deleted_at is not null as d from ${EV} where id = $1`, [ids.del]))[0];
    check("dòng vẫn xoá mềm, tiêu đề không bị hồi sinh", row?.d === true && row?.title === "ACC: sẽ xoá", js(row));

    section("LWW theo trường (hai máy sửa hai cột khác nhau)");
    await upload(tokA, [{ op: "PUT", table: EV, id: ids.merge, data: evData({ title: "ACC: gốc" }) }]);
    const m1 = await upload(tokA, [{ op: "PATCH", table: EV, id: ids.merge, data: { title: "ACC: máy 1 đổi tiêu đề" } }]); // máy 1 chỉ đổi title
    const m2 = await upload(tokA, [{ op: "PATCH", table: EV, id: ids.merge, data: { alert_min: 10 } }]); // máy 2 chỉ đổi alert_min
    check("hai PATCH khác cột đều ACCEPTED", results(m1)[0]?.status === "ACCEPTED" && results(m2)[0]?.status === "ACCEPTED", js([m1.body, m2.body]));
    const merged = (await q(`select title, alert_min from ${EV} where id = $1`, [ids.merge]))[0];
    check("giữ cả hai thay đổi (title của máy 1 + alert_min của máy 2)", merged?.title === "ACC: máy 1 đổi tiêu đề" && Number(merged?.alert_min) === 10, js(merged));
  } finally {
    await cleanup();
    await db.end();
  }
  console.log(`\n${failures.length ? "✗" : "✓"} accept:calendar — ${passed} kiểm đạt${failures.length ? `, ${failures.length} hỏng:\n  - ${failures.join("\n  - ")}` : ""}`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error("accept:calendar lỗi:", e);
  process.exit(1);
});
