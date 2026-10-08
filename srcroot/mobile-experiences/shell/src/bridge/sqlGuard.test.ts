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
    expect(g.sql).toContain('FROM app_hello_items WHERE deleted_at IS NULL');
    expect(g.kind).toBe('select');
  });
  test('SELECT tự lọc dòng xoá mềm, giữ bí danh; includeDeleted tắt bộ lọc', () => {
    expect(guardSql('SELECT title FROM items', [], ctx).sql).toBe(
      'SELECT title FROM (SELECT * FROM app_hello_items WHERE deleted_at IS NULL) AS items',
    );
    expect(guardSql('SELECT i.title FROM items AS i WHERE i.done = ?', [1], ctx).sql).toBe(
      'SELECT i . title FROM (SELECT * FROM app_hello_items WHERE deleted_at IS NULL) AS i WHERE i . done = ?',
    );
    expect(guardSql('SELECT i.title FROM items i ORDER BY i.title LIMIT 5', [], ctx).sql).toContain(') AS i ORDER BY');
    expect(guardSql('SELECT * FROM items', [], { ...ctx, includeDeleted: true }).sql).toBe('SELECT * FROM app_hello_items AS items');
  });
  test('nối bảng bằng dấu phẩy bị từ chối (không để lộ bảng ngoài manifest)', () => {
    rejects('SELECT * FROM items, secrets');
    rejects('SELECT * FROM items i, platform_apps p');
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
      "UPDATE app_hello_items SET title = ?, updated_at = '2026-10-08T00:00:00.000Z' WHERE deleted_at IS NULL AND ( id = ? )",
    );
    expect(g.params).toEqual(['n', 'id1']);
  });
  test('DELETE thành xoá mềm', () => {
    const g = guardSql('DELETE FROM items WHERE id = ?', ['id1'], ctx);
    expect(g.sql).toMatch(/^UPDATE app_hello_items SET deleted_at = '2026/);
    expect(g.sql).toContain('WHERE deleted_at IS NULL AND ( id = ? )');
    expect(g.kind).toBe('delete');
    expect(guardSql('DELETE FROM items', [], ctx).sql).toMatch(/ WHERE deleted_at IS NULL$/);
  });
  test('UPDATE/DELETE không dùng ORDER/LIMIT', () => {
    rejects('DELETE FROM items WHERE id = ? LIMIT 1', ['x']);
  });
});
