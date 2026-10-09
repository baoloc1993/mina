// Acceptance W4 (phía server của Ghi chú): AC-1 (hàm dọn thùng rác + lịch), AC-7 (RLS, xoá thắng sửa, lô > 100 chia khúc).
//   npm run accept:notes     (cần `make dev` + `python deployment/local/seed/seed.py` — `--notes` để có dữ liệu mẫu)
// Chỉ dùng dòng thử (UUID sinh lúc chạy, dọn sau) và dọn sau khi chạy; hàm dọn thùng rác chạy trong giao dịch ROLLBACK nên dữ liệu mẫu không đổi.
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
const N = "app_vn_app_note_notes";
const BL = "app_vn_app_note_note_blocks";

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

async function main(): Promise<void> {
  if (!ANON || !SERVICE) throw new Error("thiếu SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY trong deployment/local/.env");
  const db = new pg.Client({ connectionString: cfg.databaseUrl });
  await db.connect();
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
  const tenantOf = async (email: string) => (await q("select t.id from tenants t join auth.users u on u.id = t.owner_user_id where u.email = $1", [email]))[0]?.id as string;
  const [tA, tB] = [await tenantOf(A), await tenantOf(B)];
  const made: string[] = []; // mọi id dòng thử (upload đòi UUID thật, không có tiền tố) — để dọn đúng những dòng này
  const uid = () => (made.push(randomUUID()), made[made.length - 1]);
  const ids = { note: uid(), noteB: uid(), blocks: Array.from({ length: 120 }, uid) };
  const cleanup = async () => {
    await q(`delete from ${BL} where id = any($1) or note_id = any($1)`, [made]);
    await q(`delete from ${N} where id = any($1)`, [made]);
    await q("delete from sync_rejections where row_id = any($1)", [made]);
  };
  try {
    section("Chuẩn bị");
    const have = await q("select to_regclass('public.app_vn_app_note_notes') as t, (select count(*)::int from app_tables where app_id = 'vn.app.note') as n");
    check("bảng của Ghi chú đã được `registry publish` dựng (4 bảng trong app_tables)", !!have[0].t && have[0].n === 4, js(have[0]));
    await cleanup();
    const tokA = await session(A);
    const tokB = await session(B);

    section("AC-7 · RLS: tenant khác không thấy, không ghi được");
    await upload(tokA, [
      { op: "PUT", table: N, id: ids.note, data: { title: "ACC: note của A", pinned: 0, search_text: "acc note cua a", snippet: "" } },
      ...ids.blocks.slice(0, 3).map((id, i): Op => ({ op: "PUT", table: BL, id, data: { note_id: ids.note, kind: "update", data: "AA==", size: 1 + i } })),
    ]).then((r) => check("A ghi note + 3 dòng note_blocks qua upload v1", results(r).length === 4 && results(r).every((x) => x.status === "ACCEPTED"), js(r.body)));
    const aSees = (await rest(`${BL}?select=id&note_id=eq.${ids.note}`, tokA)).body as any[];
    check("A đọc lại đủ 3 dòng note_blocks của mình", aSees.length === 3, `được ${aSees.length}`);
    const bSees = await rest(`${BL}?select=id&note_id=eq.${ids.note}`, tokB);
    check("B đọc note_blocks của A → 0 dòng (RLS)", Array.isArray(bSees.body) && bSees.body.length === 0, js(bSees.body));
    const bNotes = (await rest(`${N}?select=id`, tokB)).body as any[];
    check("B đọc notes → không thấy dòng nào của A", !bNotes.some((r) => r.id === ids.note));
    const bPatch = await upload(tokB, [{ op: "PATCH", table: N, id: ids.note, data: { title: "ACC: B cố đè" } }]);
    check("B PATCH note của A → REJECTED/FORBIDDEN, ghi sync_rejections cho B", results(bPatch)[0]?.status === "REJECTED" && results(bPatch)[0]?.code === "FORBIDDEN", js(bPatch.body));
    check("note của A không đổi sau lần B cố đè", (await q(`select title from ${N} where id = $1`, [ids.note]))[0]?.title === "ACC: note của A");
    const bPut = await upload(tokB, [{ op: "PUT", table: BL, id: ids.noteB, data: { note_id: ids.note, kind: "update", data: "AA==", size: 1, tenant_id: tA } }]);
    const owner = (await q(`select tenant_id from ${BL} where id = $1`, [ids.noteB]))[0]?.tenant_id;
    check("B ghi dòng mang tenant_id của A → server ghi đè bằng tenant của B (không lọt sang A)", results(bPut)[0]?.status === "ACCEPTED" && owner === tB, `owner=${owner}`);
    check("A không thấy dòng B vừa ghi", !((await rest(`${BL}?select=id&id=eq.${ids.noteB}`, tokA)).body as any[]).length);

    section("AC-7 · Xoá thắng sửa với note");
    const del = await upload(tokA, [{ op: "PATCH", table: N, id: ids.note, data: { deleted_at: new Date().toISOString() } }]);
    check("A xoá note (xoá mềm) → ACCEPTED", results(del)[0]?.status === "ACCEPTED", js(del.body));
    const late = await upload(tokA, [
      { op: "PATCH", table: N, id: ids.note, data: { title: "ACC: máy offline sửa sau" } },
      { op: "PATCH", table: N, id: ids.note, data: { trashed_at_ms: null } },
    ]);
    check("đổi tiêu đề / Khôi phục tới sau khi note đã xoá → IGNORED/DELETED, note không hồi sinh", results(late).every((x) => x.status === "IGNORED" && x.code === "DELETED"), js(late.body));
    check("note vẫn deleted_at, tiêu đề cũ", (await q(`select title, deleted_at is not null as d from ${N} where id = $1`, [ids.note]))[0]?.d === true);
    const orphan = await upload(tokA, [{ op: "PUT", table: BL, id: ids.blocks[3], data: { note_id: ids.note, kind: "update", data: "AA==", size: 1 } }]);
    check("dòng note_blocks MỚI của máy offline vẫn ACCEPTED nhưng mồ côi (note đã xoá — dọn ở vòng 7)", results(orphan)[0]?.status === "ACCEPTED", js(orphan.body));

    section("AC-7 · Lô > 100 thay đổi chia khúc (gộp update: snapshot trước, xoá sau)");
    const over = await upload(tokA, ids.blocks.slice(0, 101).map((id): Op => ({ op: "PATCH", table: BL, id, data: { size: 1 } })));
    check("101 thay đổi một lô → 400 BAD_REQUEST (connector phải chia ≤ 100)", over.status === 400, `HTTP ${over.status}`);
    const mk = (id: string): Op => ({ op: "PUT", table: BL, id, data: { note_id: ids.note, kind: "update", data: "AA==", size: 1 } });
    for (let i = 0; i < ids.blocks.length; i += 100) {
      const r = await upload(tokA, ids.blocks.slice(i, i + 100).map(mk));
      if (i === 0) check("PUT 100 dòng một lô → ACCEPTED hết", results(r).length === 100 && results(r).every((x) => x.status !== "REJECTED"), js(r.body).slice(0, 160));
    }
    const t = new Date().toISOString();
    const chunk1: Op[] = [{ op: "PUT", table: BL, id: uid(), data: { note_id: ids.note, kind: "snapshot", data: "AA==", size: 1 } }, ...ids.blocks.slice(0, 99).map((id): Op => ({ op: "PATCH", table: BL, id, data: { deleted_at: t } }))];
    const r1 = await upload(tokA, chunk1);
    check("khúc 1 (snapshot + 99 xoá mềm) → ACCEPTED hết", results(r1).length === 100 && results(r1).every((x) => x.status === "ACCEPTED"), js(r1.body).slice(0, 160));
    const mid = (await q(`select kind, deleted_at is not null as d from ${BL} where note_id = $1 and tenant_id = $2`, [ids.note, tA])) as { kind: string; d: boolean }[];
    check("giữa hai khúc: đã thấy xoá thì CHẮC CHẮN đã có snapshot (không bao giờ xoá mà thiếu snapshot)", !mid.some((r) => r.d) || mid.some((r) => r.kind === "snapshot" && !r.d), js(mid.slice(0, 3)));
    const r2 = await upload(tokA, ids.blocks.slice(99, 119).map((id): Op => ({ op: "PATCH", table: BL, id, data: { deleted_at: t } })));
    check("khúc 2 (xoá phần còn lại) → ACCEPTED hết; xoá lại dòng đã xoá vẫn idempotent", results(r2).every((x) => x.status === "ACCEPTED"), js(r2.body).slice(0, 160));

    section("Trần độ dài / giá trị hợp lệ ở server (dogfood breaker #1)");
    const longTitle = await upload(tokA, [{ op: "PUT", table: N, id: uid(), data: { title: "x".repeat(300), pinned: 0, search_text: "", snippet: "" } }]);
    check("tiêu đề 300 ký tự → REJECTED (SCHEMA)", results(longTitle)[0]?.status === "REJECTED", js(longTitle.body));
    const badKind = await upload(tokA, [{ op: "PUT", table: BL, id: uid(), data: { note_id: ids.note, kind: "zzz", data: "AA==", size: 1 } }]);
    check("note_blocks kind lạ → REJECTED", results(badKind)[0]?.status === "REJECTED", js(badKind.body));
    const negSize = await upload(tokA, [{ op: "PUT", table: BL, id: uid(), data: { note_id: ids.note, kind: "update", data: "AA==", size: -5 } }]);
    check("note_blocks size âm → REJECTED", results(negSize)[0]?.status === "REJECTED", js(negSize.body));
    const okBlock = await upload(tokA, [{ op: "PUT", table: BL, id: uid(), data: { note_id: ids.note, kind: "update", data: "AA==", size: 1 } }]);
    check("dòng hợp lệ vẫn được nhận (ràng buộc không chặn nhầm)", results(okBlock)[0]?.status === "ACCEPTED", js(okBlock.body));

    section("AC-1 · Hàm dọn thùng rác + lịch pg_cron");
    check("tenant không gọi được RPC purge_trashed_notes (không lộ ra PostgREST)", (await http(`${API}/rest/v1/rpc/purge_trashed_notes`, { method: "POST", token: tokA, body: "{}" })).status >= 400);
    const cron = await q("select schedule from cron.job where jobname = 'purge-trashed-notes'").catch(() => []);
    check("job pg_cron `purge-trashed-notes` được lên lịch hằng ngày 03:00 UTC", cron[0]?.schedule === "0 3 * * *", js(cron));
    await db.query("begin");
    try {
      await db.query(`alter table ${N} disable trigger user`);
      const old = randomUUID();
      const fresh = randomUUID();
      const day = 86_400_000;
      for (const [id, days] of [[old, 31], [fresh, 3]] as const) {
        await db.query(
          `insert into ${N} (id, tenant_id, title, trashed_at_ms, updated_at) values ($1, $2, 'ACC: thùng rác', $3, now() - ($4 || ' days')::interval)`,
          [id, tA, Date.now() - days * day, String(days)],
        );
      }
      const purged = (await db.query("select public.purge_trashed_notes() as n")).rows[0].n as number;
      const st = (await db.query(`select id, deleted_at is not null as d from ${N} where id in ($1, $2)`, [old, fresh])).rows as { id: string; d: boolean }[];
      check("hàm dọn xoá mềm note quá 30 ngày, giữ note còn hạn", purged >= 1 && st.find((r) => r.id === old)?.d === true && st.find((r) => r.id === fresh)?.d === false, js({ purged, st }));
    } finally {
      await db.query("rollback");
    }
    const seedOk = (await q(`select count(*)::int as n from ${N} where tenant_id = $1 and deleted_at is null`, [tA]))[0].n as number;
    console.log(`  · ghi chú mẫu của A còn nguyên sau khi thử hàm dọn (rollback): ${seedOk}`);
  } finally {
    await cleanup();
    await db.end();
  }
  console.log(`\n${failures.length ? "✗" : "✓"} accept:notes — ${passed} kiểm đạt${failures.length ? `, ${failures.length} hỏng:\n  - ${failures.join("\n  - ")}` : ""}`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error("accept:notes lỗi:", e);
  process.exit(1);
});
