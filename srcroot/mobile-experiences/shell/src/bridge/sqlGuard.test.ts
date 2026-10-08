import { guardSql, SqlRejected } from './sqlGuard';

const ctx = {
  allowedTables: ['items'],
  prefix: 'app_hello_',
  tenantId: 'T1',
  now: '2026-10-08T00:00:00.000Z',
};
const rejects = (sql: string, p: unknown[] = []) =>
  expect(() => guardSql(sql, p, ctx)).toThrow(SqlRejected);

describe('AC-6 ca phá: mọi ca bị từ chối', () => {
  test('(a) bảng không khai trong manifest', () => {
    rejects('SELECT * FROM secrets');
    rejects('SELECT * FROM app_hello_items');
    rejects('INSERT INTO other (id) VALUES (?)', ['x']);
  });
  test('(b) SQL không parse được', () => {
    rejects('SELEC * FRM items');
    rejects('');
    rejects("SELECT * FROM items WHERE title = 'abc");
  });
  test('(c) ATTACH / PRAGMA / DROP / CREATE / nhiều câu / comment / subquery / union', () => {
    rejects("ATTACH DATABASE 'x.db' AS x");
    rejects('PRAGMA key = 1');
    rejects('DROP TABLE items');
    rejects('CREATE TABLE x (a)');
    rejects('SELECT * FROM items; DROP TABLE items');
    rejects('SELECT * FROM items -- hi');
    rejects('SELECT * FROM items /* x */');
    rejects('SELECT * FROM items WHERE id IN (SELECT id FROM secrets)');
    rejects('SELECT id FROM items UNION SELECT name FROM sqlite_master');
    rejects('SELECT * FROM sqlite_master');
    rejects('SELECT * FROM items JOIN secrets');
  });
});

describe('ca hợp lệ', () => {
  test('SELECT đổi tên bảng', () => {
    const g = guardSql('SELECT * FROM items WHERE deleted_at IS NULL ORDER BY created_at', [], ctx);
    expect(g.sql).toContain('FROM app_hello_items');
    expect(g.kind).toBe('select');
  });
  test('INSERT ghi đè cột hệ thống, bỏ giá trị app truyền', () => {
    const g = guardSql(
      'INSERT INTO items (id, title, tenant_id, created_at) VALUES (?, ?, ?, ?)',
      ['id1', 't', 'T-EVIL', 'x'],
      ctx,
    );
    expect(g.sql).toBe(
      "INSERT INTO app_hello_items (id, title, tenant_id, created_at, updated_at) VALUES (?, ?, 'T1', '2026-10-08T00:00:00.000Z', '2026-10-08T00:00:00.000Z')",
    );
    expect(g.params).toEqual(['id1', 't']);
    expect(g.sql).not.toContain('T-EVIL');
  });
  test('INSERT không có id bị từ chối', () => {
    rejects('INSERT INTO items (title) VALUES (?)', ['t']);
  });
  test('UPDATE bỏ cột hệ thống, tự cập nhật updated_at', () => {
    const g = guardSql('UPDATE items SET title = ?, tenant_id = ? WHERE id = ?', ['n', 'T-EVIL', 'id1'], ctx);
    expect(g.sql).toBe(
      "UPDATE app_hello_items SET title = ?, updated_at = '2026-10-08T00:00:00.000Z' WHERE id = ?",
    );
    expect(g.params).toEqual(['n', 'id1']);
  });
  test('DELETE thành xoá mềm', () => {
    const g = guardSql('DELETE FROM items WHERE id = ?', ['id1'], ctx);
    expect(g.sql).toMatch(/^UPDATE app_hello_items SET deleted_at = '2026/);
    expect(g.sql).toContain('WHERE id = ?');
    expect(g.kind).toBe('delete');
  });
});
