import assert from "node:assert/strict";
import { test } from "node:test";
import { RegistryError, type RegistryCode } from "./errors.ts";
import { lintMigration, splitStatements } from "./lint.ts";

const P = "app_vn_app_note";

function code(sql: string, prefix = P): RegistryCode | "OK" {
  try {
    lintMigration(sql, prefix);
    return "OK";
  } catch (e) {
    if (e instanceof RegistryError) return e.code;
    throw e;
  }
}

test("cho phép: tạo bảng, thêm cột nullable/có default, tạo index — trong prefix", () => {
  const r = lintMigration(
    `-- ghi chú
     CREATE TABLE IF NOT EXISTS app_vn_app_note_notes (
       id uuid primary key, title text not null default '', body text, folder_id uuid references app_vn_app_note_folders (id)
     );
     ALTER TABLE app_vn_app_note_notes ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT false;
     ALTER TABLE app_vn_app_note_notes ADD COLUMN tag text;
     CREATE INDEX IF NOT EXISTS app_vn_app_note_notes_pinned ON app_vn_app_note_notes (pinned);`,
    P,
  );
  assert.deepEqual(r.createdTables, ["app_vn_app_note_notes"]);
  assert.equal(r.statements.length, 4);
});

test("chặn kiểu không cộng thêm → MIGRATION_NOT_ADDITIVE", () => {
  for (const sql of [
    "DROP TABLE app_vn_app_note_notes",
    "ALTER TABLE app_vn_app_note_notes DROP COLUMN title",
    "ALTER TABLE app_vn_app_note_notes RENAME TO app_vn_app_note_old",
    "ALTER TABLE app_vn_app_note_notes RENAME COLUMN a TO b",
    "ALTER TABLE app_vn_app_note_notes ALTER COLUMN title TYPE integer",
    "ALTER TABLE app_vn_app_note_notes ADD COLUMN must text NOT NULL",
    "ALTER TABLE app_vn_app_note_notes ADD COLUMN a text, ADD COLUMN b text",
    "ALTER TABLE app_vn_app_note_notes ADD CONSTRAINT x CHECK (true)",
    "CREATE TABLE app_vn_app_note_x (id uuid)",
    "CREATE TABLE IF NOT EXISTS app_vn_app_note_x AS SELECT 1",
    "CREATE TABLE IF NOT EXISTS app_vn_app_note_x (LIKE tenants)",
    "TRUNCATE app_vn_app_note_notes",
    "GRANT ALL ON app_vn_app_note_notes TO anon",
    "CREATE FUNCTION f() RETURNS int LANGUAGE sql AS 'select 1'",
    "DELETE FROM app_vn_app_note_notes",
    "UPDATE tenants SET plan = 'x'",
  ]) {
    assert.equal(code(sql), "MIGRATION_NOT_ADDITIVE", sql);
  }
});

test("chặn bảng / index / tham chiếu ngoài prefix → TABLE_OUTSIDE_PREFIX", () => {
  for (const sql of [
    "CREATE TABLE IF NOT EXISTS tenants_copy (id uuid)",
    "CREATE TABLE IF NOT EXISTS app_vn_app_notebook_x (id uuid)", // prefix gần giống nhưng khác
    "ALTER TABLE tenants ADD COLUMN x text",
    "ALTER TABLE app_hello_items ADD COLUMN x text",
    "CREATE INDEX IF NOT EXISTS app_vn_app_note_i ON tenants (id)",
    "CREATE INDEX IF NOT EXISTS idx_chung ON app_vn_app_note_notes (id)",
    "CREATE TABLE IF NOT EXISTS app_vn_app_note_a (id uuid, t uuid references tenants (id))",
  ]) {
    assert.equal(code(sql), "TABLE_OUTSIDE_PREFIX", sql);
  }
});

test("schema khác public bị từ chối (fail-closed)", () => {
  assert.notEqual(code("CREATE TABLE IF NOT EXISTS other.app_vn_app_note_a (id uuid)"), "OK");
});

test("fail-closed với cú pháp lạ: dollar-quote, ident trích dẫn, chuỗi không đóng", () => {
  assert.equal(code("CREATE TABLE IF NOT EXISTS app_vn_app_note_a (id uuid default $$x$$)"), "MIGRATION_NOT_ADDITIVE");
  assert.equal(code('CREATE TABLE IF NOT EXISTS "app_vn_app_note_a" (id uuid)'), "MIGRATION_NOT_ADDITIVE");
  assert.equal(code("CREATE TABLE IF NOT EXISTS app_vn_app_note_a (t text default 'abc)"), "MIGRATION_NOT_ADDITIVE");
});

test("nối nhiều câu lệnh trong một dòng không lọt: câu thứ hai vẫn bị lint", () => {
  assert.equal(code("CREATE INDEX IF NOT EXISTS app_vn_app_note_i ON app_vn_app_note_a (id); DROP TABLE tenants"), "MIGRATION_NOT_ADDITIVE");
});

test("dấu ; trong chuỗi và comment không tách câu lệnh sai", () => {
  const s = splitStatements("create table if not exists a (t text default 'x;y'); /* c; d */ -- e; f\ncreate index i on a (t)");
  assert.equal(s.length, 2);
});

test("prefix hello (app_hello) cho bảng cũ", () => {
  assert.equal(code("ALTER TABLE app_hello_items ADD COLUMN note text", "app_hello"), "OK");
});
