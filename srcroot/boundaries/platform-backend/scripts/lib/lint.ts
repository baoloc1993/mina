// Lint migration của mini app (fail-closed): chỉ cho phép kiểu CỘNG THÊM trên bảng thuộc `table_prefix`.
//   CREATE TABLE IF NOT EXISTS <prefix>_*  ·  ALTER TABLE <prefix>_* ADD COLUMN (nullable hoặc có default)
//   CREATE [UNIQUE] INDEX [IF NOT EXISTS] <prefix>_* ON <prefix>_*
// Mọi thứ khác (DROP, RENAME, đổi type, NOT NULL không default, GRANT, function, trigger, bảng ngoài prefix…) bị chặn.
import { RegistryError } from "./errors.ts";

export type LintResult = { statements: string[]; createdTables: string[] };

/** Bỏ comment, từ chối `$` (dollar-quote) và `"` (ident trích dẫn), tách câu lệnh theo `;` ngoài chuỗi. */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const two = sql.slice(i, i + 2);
    if (two === "--") {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (two === "/*") {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) throw new RegistryError("MIGRATION_NOT_ADDITIVE", "comment /* không đóng");
      i = end + 2;
      cur += " ";
      continue;
    }
    if (ch === "$") throw new RegistryError("MIGRATION_NOT_ADDITIVE", "không cho dùng dollar-quote ($) trong migration của mini app");
    if (ch === '"') throw new RegistryError("MIGRATION_NOT_ADDITIVE", 'không cho dùng định danh trích dẫn (") — dùng chữ thường a-z0-9_');
    if (ch === "'") {
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) throw new RegistryError("MIGRATION_NOT_ADDITIVE", "chuỗi ' không đóng");
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      cur += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === ";") {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const IDENT = "[a-z_][a-z0-9_]*";
const QUAL = `(?:public\\.)?(${IDENT})`;

function topLevelHasComma(s: string): boolean {
  let depth = 0;
  let inStr = false;
  for (const ch of s) {
    if (ch === "'") inStr = !inStr;
    if (inStr) continue;
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) return true;
  }
  return false;
}

function mustHavePrefix(name: string, prefix: string, what = "bảng"): void {
  if (name.length > 63) throw new RegistryError("TABLE_OUTSIDE_PREFIX", `${what} ${name} dài quá 63 ký tự`);
  if (!name.startsWith(`${prefix}_`)) {
    throw new RegistryError("TABLE_OUTSIDE_PREFIX", `${what} ${name} không bắt đầu bằng "${prefix}_"`);
  }
}

function checkReferences(body: string, prefix: string): void {
  for (const m of body.matchAll(new RegExp(`references\\s+(?:public\\.)?(${IDENT})`, "g"))) {
    mustHavePrefix(m[1], prefix, "bảng được tham chiếu");
  }
}

export function lintMigration(sql: string, prefix: string): LintResult {
  const statements = splitStatements(sql);
  const createdTables: string[] = [];
  for (const stmt of statements) {
    const n = stmt.replace(/\s+/g, " ").trim().toLowerCase();

    let m = n.match(new RegExp(`^create table if not exists ${QUAL} ?\\((.*)\\)$`));
    if (m) {
      mustHavePrefix(m[1], prefix);
      const body = m[2];
      if (/\b(inherits|partition|like|exclude|generated|select|create)\b/.test(body)) {
        throw new RegistryError(
          "MIGRATION_NOT_ADDITIVE",
          `bảng ${m[1]} dùng cấu trúc không được phép (inherits/partition/like/exclude/generated/subquery)`,
        );
      }
      checkReferences(body, prefix);
      createdTables.push(m[1]);
      continue;
    }
    if (/^create table\b/.test(n)) {
      throw new RegistryError(
        "MIGRATION_NOT_ADDITIVE",
        "dùng `CREATE TABLE IF NOT EXISTS <prefix>_… (…)` (không AS, không UNLOGGED/TEMP, không thiếu IF NOT EXISTS)",
      );
    }

    m = n.match(new RegExp(`^alter table ${QUAL} add column (?:if not exists )?(${IDENT}) (.+)$`));
    if (m) {
      mustHavePrefix(m[1], prefix);
      const rest = m[3];
      if (topLevelHasComma(rest)) throw new RegistryError("MIGRATION_NOT_ADDITIVE", "mỗi ALTER chỉ thêm một cột — tách thành nhiều câu lệnh");
      if (/\bnot null\b/.test(rest) && !/\bdefault\b/.test(rest)) {
        throw new RegistryError("MIGRATION_NOT_ADDITIVE", `cột ${m[2]} NOT NULL không có DEFAULT (bảng cũ đã có dữ liệu)`);
      }
      if (/\b(primary key|generated|select)\b/.test(rest)) {
        throw new RegistryError("MIGRATION_NOT_ADDITIVE", `cột ${m[2]} dùng cấu trúc không được phép`);
      }
      checkReferences(rest, prefix);
      continue;
    }
    m = n.match(new RegExp(`^alter table ${QUAL}\\b`));
    if (m) {
      // ALTER TABLE <ngoài prefix> → báo lỗi prefix trước; còn lại (RENAME, DROP, ALTER COLUMN TYPE…) không cộng thêm.
      mustHavePrefix(m[1], prefix);
      throw new RegistryError("MIGRATION_NOT_ADDITIVE", `ALTER TABLE ${m[1]}: chỉ cho phép ADD COLUMN (không DROP/RENAME/đổi kiểu/ADD CONSTRAINT)`);
    }

    m = n.match(new RegExp(`^create (?:unique )?index (?:if not exists )?(${IDENT}) on ${QUAL}(?: using ${IDENT})? ?\\(.*\\)(?: where .*)?$`));
    if (m) {
      mustHavePrefix(m[1], prefix, "tên index");
      mustHavePrefix(m[2], prefix);
      if (/\bselect\b/.test(n)) throw new RegistryError("MIGRATION_NOT_ADDITIVE", "index không được chứa subquery");
      continue;
    }

    throw new RegistryError("MIGRATION_NOT_ADDITIVE", `câu lệnh không nằm trong danh sách cho phép: ${n.slice(0, 80)}${n.length > 80 ? "…" : ""}`);
  }
  return { statements, createdTables };
}
