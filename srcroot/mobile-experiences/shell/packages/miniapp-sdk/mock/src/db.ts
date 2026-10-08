// Cơ sở dữ liệu của mock SDK: lớp mỏng trên một "driver" SQLite đồng bộ (SQLite WASM ở trình duyệt, node:sqlite ở test).
// Việc DUY NHẤT ở đây là dựng schema giống shell: bảng core_*, chạy migration của fixture, bổ sung cột hệ thống.
import type { Manifest, Stmt } from '../../../../src/bridge/bridge';

/** Driver đồng bộ tối thiểu — mọi thao tác chạy trọn trong một lượt, nên transaction không bị xen kẽ. */
export interface SqlDriver {
  exec(sql: string): void;
  all(sql: string, params: unknown[]): Record<string, unknown>[];
  run(sql: string, params: unknown[]): void;
}

export const SYSTEM_COLUMNS = ['tenant_id', 'created_at', 'updated_at', 'deleted_at'] as const;

/** Bảng dùng chung (ARCHITECTURE.md §6) — cột cố ý đủ cho các câu SQL cố định của bridge. */
export const CORE_DDL = `
CREATE TABLE IF NOT EXISTS core_tags (
  id text PRIMARY KEY, tenant_id text, name text NOT NULL, color text,
  created_at text, updated_at text, deleted_at text
);
CREATE TABLE IF NOT EXISTS core_contacts (
  id text PRIMARY KEY, tenant_id text, name text NOT NULL, phone text, email text, note text,
  created_at text, updated_at text, deleted_at text
);
CREATE TABLE IF NOT EXISTS core_files (
  id text PRIMARY KEY, tenant_id text, app_id text, name text NOT NULL, mime text NOT NULL, size integer NOT NULL DEFAULT 0,
  uploaded_at text, created_at text, updated_at text, deleted_at text
);
CREATE TABLE IF NOT EXISTS _mock_migrations (name text PRIMARY KEY);
`;

export interface Migration {
  name: string;
  sql: string;
}

export function runTransaction(d: SqlDriver, stmts: Stmt[]): void {
  d.exec('BEGIN');
  try {
    for (const s of stmts) d.run(s.sql, s.params);
    d.exec('COMMIT');
  } catch (e) {
    try {
      d.exec('ROLLBACK');
    } catch {
      /* đã tự rollback */
    }
    throw e;
  }
}

/**
 * Tiền tố bảng của app, suy ra từ migration: bảng `<tiền tố>_<tên ngắn>` đầu tiên trong `manifest.tables`.
 * Không có migration nào khớp → mặc định `app_` + id đổi `.`/`-` thành `_` (đúng quy ước CLI registry).
 */
export function inferTablePrefix(manifest: Manifest, migrations: Migration[]): string {
  const short = manifest.tables[0];
  if (short) {
    const re = new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(app_[A-Za-z0-9_]*?)_${short}\\b`, 'i');
    for (const m of migrations) {
      const hit = re.exec(m.sql);
      if (hit) return hit[1];
    }
  }
  return defaultTablePrefix(manifest.id);
}

export function defaultTablePrefix(appId: string): string {
  return 'app_' + appId.replace(/[.\-]/g, '_').toLowerCase();
}

export interface PrepareResult {
  applied: string[];
  skipped: string[];
  addedColumns: string[];
  warnings: string[];
}

/** Dựng schema: core_*, migration chưa áp (theo thứ tự tên), rồi thêm cột hệ thống còn thiếu vào bảng của app. */
export function prepareDatabase(d: SqlDriver, manifest: Manifest, tablePrefix: string, migrations: Migration[]): PrepareResult {
  const res: PrepareResult = { applied: [], skipped: [], addedColumns: [], warnings: [] };
  d.exec(CORE_DDL);
  const done = new Set(d.all('SELECT name FROM _mock_migrations', []).map((r) => String(r.name)));
  for (const m of [...migrations].sort((a, b) => a.name.localeCompare(b.name))) {
    if (done.has(m.name)) {
      res.skipped.push(m.name);
      continue;
    }
    d.exec('BEGIN');
    try {
      d.exec(m.sql);
      d.run('INSERT INTO _mock_migrations (name) VALUES (?)', [m.name]);
      d.exec('COMMIT');
    } catch (e) {
      try {
        d.exec('ROLLBACK');
      } catch {
        /* bỏ qua */
      }
      throw new Error(`Migration ${m.name} lỗi trên SQLite: ${(e as Error).message}`);
    }
    res.applied.push(m.name);
  }
  for (const short of manifest.tables) {
    const table = `${tablePrefix}_${short}`;
    const cols = new Set(d.all(`PRAGMA table_info(${table})`, []).map((r) => String(r.name)));
    if (!cols.size) {
      res.warnings.push(`Bảng ${table} chưa có trong migration nào — SQL của app vào bảng "${short}" sẽ lỗi.`);
      continue;
    }
    for (const c of SYSTEM_COLUMNS) {
      if (cols.has(c)) continue;
      d.exec(`ALTER TABLE ${table} ADD COLUMN ${c} text`);
      res.addedColumns.push(`${table}.${c}`);
    }
  }
  return res;
}
