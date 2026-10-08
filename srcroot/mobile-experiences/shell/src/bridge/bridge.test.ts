import { handleRpc, type BridgeDeps, type RpcRequest } from './bridge';

const manifest = {
  id: 'vn.app.hello',
  name: 'Hello',
  version: '0.0.1',
  entry: 'index.html',
  scopes: ['db', 'auth.token'],
  tables: ['items'],
};

function deps(over: Partial<BridgeDeps> = {}): BridgeDeps & { executed: string[] } {
  const executed: string[] = [];
  return {
    manifest,
    getTenantId: () => 'T1',
    now: () => '2026-10-08T00:00:00.000Z',
    dbGetAll: async () => [],
    dbExecute: async (sql) => void executed.push(sql),
    getAppToken: async () => ({ token: 't', expires_at: 1 }),
    onReady: jest.fn(),
    executed,
    ...over,
  };
}
const rpc = (method: string, params?: RpcRequest['params']): RpcRequest => ({ jsonrpc: '2.0', id: 1, method, params });

test('(d) namespace không có scope → SCOPE_DENIED', async () => {
  const r = await handleRpc(rpc('notify.local', {}), deps());
  expect(r.error?.code).toBe('SCOPE_DENIED');
});

test('method có thật nhưng manifest không khai scope → SCOPE_DENIED', async () => {
  const d = deps({ manifest: { ...manifest, scopes: [] } });
  const r = await handleRpc(rpc('db.query', { sql: 'SELECT * FROM items' }), d);
  expect(r.error?.code).toBe('SCOPE_DENIED');
});

test('ca phá SQL không chạm DB', async () => {
  const d = deps();
  for (const sql of ['SELECT * FROM secrets', 'DROP TABLE items', 'PRAGMA key=1', "ATTACH DATABASE 'x' AS y", 'SELEC garbage']) {
    const r = await handleRpc(rpc('db.execute', { sql }), d);
    expect(r.error?.code).toBe('SQL_REJECTED');
  }
  expect(d.executed).toEqual([]);
});

test('INSERT hợp lệ đổi tên bảng và ghi đè tenant_id', async () => {
  const d = deps();
  const r = await handleRpc(
    rpc('db.execute', { sql: 'INSERT INTO items (id, title, tenant_id) VALUES (?, ?, ?)', params: ['i1', 'a', 'EVIL'] }),
    d,
  );
  expect(r.result).toBe(true);
  expect(d.executed[0]).toContain('app_hello_items');
  expect(d.executed[0]).toContain("'T1'");
  expect(d.executed[0]).not.toContain('EVIL');
});

test('sdk.ready gọi onReady', async () => {
  const d = deps();
  await handleRpc(rpc('sdk.ready'), d);
  expect(d.onReady).toHaveBeenCalled();
});

test('auth.getAppToken dùng app_id của manifest, bỏ qua tham số app truyền', async () => {
  const getAppToken = jest.fn(async () => ({ token: 't', expires_at: 1 }));
  await handleRpc(rpc('auth.getAppToken', { app_id: 'vn.evil.app' }), deps({ getAppToken }));
  expect(getAppToken).toHaveBeenCalledWith('vn.app.hello');
});

test('offline không có token cache → OFFLINE', async () => {
  const offline = Object.assign(new Error('x'), { code: 'OFFLINE' });
  const r = await handleRpc(rpc('auth.getAppToken'), deps({ getAppToken: async () => { throw offline; } }));
  expect(r.error?.code).toBe('OFFLINE');
});
