// Driver SQLite cho test chạy trên Node: dùng node:sqlite có sẵn (không thêm dependency native).
import { DatabaseSync } from 'node:sqlite';
import type { SqlDriver } from '../mock/src/db';

export function openNodeDb(): SqlDriver & { raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:');
  return {
    raw,
    exec: (sql) => void raw.exec(sql),
    all: (sql, params) => raw.prepare(sql).all(...(params as never[])).map((r) => ({ ...r })) as Record<string, unknown>[],
    run: (sql, params) => void raw.prepare(sql).run(...(params as never[])),
  };
}
