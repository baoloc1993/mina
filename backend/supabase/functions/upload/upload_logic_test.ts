import { assertEquals } from "jsr:@std/assert@1";
import { classifyDbError, MAX_OPS, type Op, type PatchOutcome, processOps, type Rejection, type Store, type StoreError } from "./upload_logic.ts";

const TA = "aaaaaaaa-0000-0000-0000-00000000000a";
const TB = "bbbbbbbb-0000-0000-0000-00000000000b";
const R1 = "11111111-1111-1111-1111-111111111111";
const R2 = "22222222-2222-2222-2222-222222222222";

type Row = Record<string, unknown> & { id: string; tenant_id: string; deleted_at?: string | null };

/** Store giả: mô phỏng RLS theo tenant của người gọi, ghi theo thứ tự nhận, updated_at do "server" đặt. */
function fakeStore(tenant: string, rows: Row[] = [], clock = { n: 0 }) {
  const db = new Map<string, Row>(rows.map((r) => [r.id, structuredClone(r)]));
  const rejections: Rejection[] = [];
  const dbErrors: Record<string, StoreError> = {};
  const store: Store = {
    allowedTables: () => Promise.resolve(new Set(["app_hello_items"])),
    patch(_t, id, data, deletedAt): Promise<PatchOutcome | StoreError> {
      if (dbErrors[id]) return Promise.resolve(dbErrors[id]);
      const row = db.get(id);
      if (!row || row.tenant_id !== tenant) return Promise.resolve("missing"); // RLS: không thấy
      if (row.deleted_at) return Promise.resolve("deleted");
      if (data.bad_col !== undefined) return Promise.resolve({ error: { code: "PGRST204", message: "no column bad_col" } });
      Object.assign(row, data);
      if (deletedAt) row.deleted_at = deletedAt;
      if (Object.keys(data).length || deletedAt) row.updated_at = `t${++clock.n}`;
      return Promise.resolve("updated");
    },
    insert(_t, row) {
      if (db.has(row.id as string)) return Promise.resolve({ error: { code: "23505", message: "dup" } });
      if (row.title === "") return Promise.resolve({ error: { code: "23514", message: "check" } });
      db.set(row.id as string, { ...(row as Row), updated_at: `t${++clock.n}` });
      return Promise.resolve(null);
    },
    reject(rec) {
      rejections.push(rec);
      return Promise.resolve();
    },
  };
  return { store, db, rejections, dbErrors };
}

const NOW = () => "2026-10-08T12:00:00.000Z";
const put = (id: string, data: Record<string, unknown>): Op => ({ op: "PUT", table: "app_hello_items", id, data });
const patch = (id: string, data: Record<string, unknown>): Op => ({ op: "PATCH", table: "app_hello_items", id, data });
const del = (id: string): Op => ({ op: "DELETE", table: "app_hello_items", id });

Deno.test("hai máy sửa hai trường khác nhau → giữ cả hai", async () => {
  const f = fakeStore(TA, [{ id: R1, tenant_id: TA, title: "gốc", done: false }]);
  const r = await processOps([patch(R1, { title: "A sửa" }), patch(R1, { done: true })], TA, f.store, NOW);
  assertEquals(r.map((x) => x.status), ["ACCEPTED", "ACCEPTED"]);
  assertEquals([f.db.get(R1)!.title, f.db.get(R1)!.done], ["A sửa", true]);
});

Deno.test("cùng trường → bản tới server sau thắng (thứ tự nhận, không tin giờ máy)", async () => {
  const f = fakeStore(TA, [{ id: R1, tenant_id: TA, title: "gốc" }]);
  // "Máy B" sửa lúc 10h nhưng tới trước; "máy A" sửa lúc 9h tới sau → A thắng (C3 của l2)
  await processOps([patch(R1, { title: "B 10h", updated_at: "2026-10-08T10:00:00Z" })], TA, f.store, NOW);
  await processOps([patch(R1, { title: "A 9h", updated_at: "2026-10-08T09:00:00Z" })], TA, f.store, NOW);
  assertEquals(f.db.get(R1)!.title, "A 9h");
  assertEquals(f.db.get(R1)!.updated_at, "t2"); // giá trị client bị bỏ, server đặt
});

Deno.test("xoá thắng sửa: PATCH sau khi dòng đã xoá → IGNORED/DELETED, không hồi sinh", async () => {
  const f = fakeStore(TA, [{ id: R1, tenant_id: TA, title: "x" }]);
  const r = await processOps([del(R1), patch(R1, { title: "muộn" }), patch(R1, { deleted_at: null })], TA, f.store, NOW);
  assertEquals(r[0].status, "ACCEPTED");
  assertEquals([r[1].status, r[1].code, r[1].ok], ["IGNORED", "DELETED", true]);
  assertEquals(r[2].status, "IGNORED"); // client không hồi sinh bằng deleted_at = null
  assertEquals(f.db.get(R1)!.deleted_at, NOW());
  assertEquals(f.db.get(R1)!.title, "x");
});

Deno.test("xoá tới sau sửa → xoá; xoá hai lần idempotent; PATCH mang deleted_at khác null = xoá mềm (bridge của shell)", async () => {
  const f = fakeStore(TA, [{ id: R1, tenant_id: TA, title: "x" }, { id: R2, tenant_id: TA, title: "y" }]);
  const r = await processOps(
    [patch(R1, { title: "sửa" }), del(R1), del(R1), patch(R2, { deleted_at: "2026-01-01T00:00:00Z", updated_at: "z" }), patch(R2, { deleted_at: "lần 2" })],
    TA, f.store, NOW,
  );
  assertEquals(r.map((x) => x.status), ["ACCEPTED", "ACCEPTED", "ACCEPTED", "ACCEPTED", "ACCEPTED"]);
  assertEquals(f.db.get(R2)!.deleted_at, NOW()); // giờ server, không phải giờ client
});

Deno.test("PUT: tạo mới; PUT trùng id gộp trường như PATCH, không nhân đôi; tenant_id luôn từ JWT", async () => {
  const f = fakeStore(TA);
  const r = await processOps(
    [put(R1, { title: "mới", tenant_id: TB, created_at: "2000-01-01" }), put(R1, { done: true }), put(R1, { title: "ghi đè" })],
    TA, f.store, NOW,
  );
  assertEquals(r.map((x) => x.status), ["ACCEPTED", "ACCEPTED", "ACCEPTED"]);
  assertEquals(f.db.size, 1);
  const row = f.db.get(R1)!;
  assertEquals([row.tenant_id, row.title, row.done, row.created_at], [TA, "ghi đè", true, undefined]);
});

Deno.test("PUT lên id của tenant khác → REJECTED/FORBIDDEN, không lộ tồn tại, ghi sync_rejections", async () => {
  const f = fakeStore(TB, [{ id: R1, tenant_id: TA, title: "của A" }]);
  const r = await processOps([put(R1, { title: "chiếm" })], TB, f.store, NOW);
  assertEquals([r[0].status, r[0].code, r[0].ok], ["REJECTED", "FORBIDDEN", false]);
  assertEquals(f.db.get(R1)!.title, "của A");
  assertEquals(f.rejections.length, 1);
  assertEquals([f.rejections[0].code, f.rejections[0].row_id, f.rejections[0].op], ["FORBIDDEN", R1, "PUT"]);
});

Deno.test("PATCH / DELETE dòng của tenant khác hoặc không tồn tại → REJECTED/FORBIDDEN (cùng một mã)", async () => {
  const f = fakeStore(TB, [{ id: R1, tenant_id: TA, title: "của A" }]);
  const r = await processOps([patch(R1, { title: "x" }), del(R1), patch(R2, { title: "không có" })], TB, f.store, NOW);
  assertEquals(r.map((x) => `${x.status}/${x.code}`), ["REJECTED/FORBIDDEN", "REJECTED/FORBIDDEN", "REJECTED/FORBIDDEN"]);
  assertEquals(f.rejections.length, 3);
});

Deno.test("một thay đổi hỏng không chặn phần còn lại của lô", async () => {
  const f = fakeStore(TA, [{ id: R1, tenant_id: TA, title: "x" }]);
  const ops: Op[] = [
    patch(R1, { title: "ok 1" }),
    { op: "PATCH", table: "bang_la", id: R1, data: {} },
    patch(R1, { bad_col: 1 }),
    put(R2, { title: "" }),
    patch(R1, { done: true }),
  ];
  const r = await processOps(ops, TA, f.store, NOW);
  assertEquals(r.map((x) => `${x.status}/${x.code ?? "-"}`), [
    "ACCEPTED/-", "REJECTED/TABLE_NOT_ALLOWED", "REJECTED/SCHEMA", "REJECTED/SCHEMA", "ACCEPTED/-",
  ]);
  assertEquals([f.db.get(R1)!.title, f.db.get(R1)!.done], ["ok 1", true]);
  assertEquals(f.rejections.map((x) => x.code), ["TABLE_NOT_ALLOWED", "SCHEMA", "SCHEMA"]);
});

Deno.test("ok giữ cho connector vòng 1: ok = status != REJECTED", async () => {
  const f = fakeStore(TA, [{ id: R1, tenant_id: TA, title: "x", deleted_at: "d" }]);
  const r = await processOps([patch(R1, { title: "y" }), patch(R2, { title: "z" })], TA, f.store, NOW);
  assertEquals(r.map((x) => [x.status, x.ok]), [["IGNORED", true], ["REJECTED", false]]);
});

Deno.test("thay đổi sai khuôn → REJECTED/BAD_OP; cột hệ thống từ client bị bỏ; tên cột lạ → SCHEMA", async () => {
  const f = fakeStore(TA, [{ id: R1, tenant_id: TA, title: "x" }]);
  const r = await processOps(
    [
      { op: "UPSERT", table: "app_hello_items", id: R1 },
      { op: "PATCH", table: "app_hello_items", id: "khong-phai-uuid", data: {} },
      patch(R1, { id: R2, tenant_id: TB, created_at: "x", updated_at: "y" }),
      patch(R1, { "title; drop table x": 1 }),
    ] as Op[],
    TA, f.store, NOW,
  );
  assertEquals(r.map((x) => x.code ?? x.status), ["BAD_OP", "BAD_OP", "ACCEPTED", "SCHEMA"]);
  assertEquals(f.db.get(R1)!.tenant_id, TA);
});

Deno.test("lỗi hạ tầng (không phân loại được) ném lên để cả lô trả 500 và engine gửi lại", async () => {
  const f = fakeStore(TA, [{ id: R1, tenant_id: TA, title: "x" }]);
  f.dbErrors[R1] = { error: { code: "08006", message: "mất kết nối" } };
  let thrown = false;
  try {
    await processOps([patch(R1, { title: "y" })], TA, f.store, NOW);
  } catch {
    thrown = true;
  }
  assertEquals(thrown, true);
  assertEquals(f.rejections.length, 0); // không biến lỗi tạm thời thành từ chối vĩnh viễn
});

Deno.test("classifyDbError", () => {
  assertEquals(classifyDbError({ code: "42501", message: "" }), "FORBIDDEN");
  assertEquals(classifyDbError({ code: "23502", message: "" }), "SCHEMA");
  assertEquals(classifyDbError({ code: "22P02", message: "" }), "SCHEMA");
  assertEquals(classifyDbError({ code: "PGRST204", message: "" }), "SCHEMA");
  assertEquals(classifyDbError({ code: "40001", message: "" }), null);
  assertEquals(MAX_OPS, 100);
});
