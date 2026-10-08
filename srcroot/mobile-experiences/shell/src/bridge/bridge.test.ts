import { handleRpc, type BridgeContext, type RpcRequest } from './bridge';
import { makeFakeHost, manifestWith } from './matrix';

const ALL = ['db.own', 'core.tags:write', 'core.contacts:write', 'core.files:read', 'intent.send', 'notify.local', 'storage.files', 'net', 'ui.native', 'auth.token'];

function setup(scopes = ALL, over: Partial<ReturnType<typeof manifestWith>> = {}, readOnly = false) {
  const fake = makeFakeHost({ readOnly });
  const ctx: BridgeContext = { manifest: { ...manifestWith(scopes), ...over }, tablePrefix: 'app_hello', host: fake.host };
  const call = (method: string, params?: RpcRequest['params']) => handleRpc({ jsonrpc: '2.0', id: 1, method, params }, ctx);
  return { fake, call };
}

describe('envelope', () => {
  test('JSON-RPC sai khuôn → INVALID_REQUEST', async () => {
    const { fake } = setup();
    const ctx: BridgeContext = { manifest: manifestWith(ALL), tablePrefix: 'app_hello', host: fake.host };
    const badReq = { jsonrpc: '1.0', id: 1, method: 'sdk.ready' } as unknown as RpcRequest;
    expect((await handleRpc(badReq, ctx)).error?.code).toBe('INVALID_REQUEST');
    expect((await handleRpc(null as unknown as RpcRequest, ctx)).error?.code).toBe('INVALID_REQUEST');
    expect(fake.total()).toBe(0);
  });
  test('params không phải object → INVALID_REQUEST', async () => {
    const { call, fake } = setup();
    expect((await call('db.query', 'SELECT 1' as unknown as RpcRequest['params'])).error?.code).toBe('INVALID_REQUEST');
    expect(fake.total()).toBe(0);
  });
});

describe('db', () => {
  test('ca phá SQL không chạm DB', async () => {
    const { call, fake } = setup();
    for (const sql of ['SELECT * FROM secrets', 'DROP TABLE items', 'PRAGMA key=1', "ATTACH DATABASE 'x' AS y", 'SELEC garbage']) {
      expect((await call('db.execute', { sql })).error?.code).toBe('SQL_REJECTED');
    }
    expect(fake.total()).toBe(0);
  });
  test('INSERT đổi tên bảng theo table_prefix và ghi đè tenant_id', async () => {
    const runs: string[] = [];
    const { fake, call } = setup();
    fake.host.db.run = async (sql) => void runs.push(sql);
    const r = await call('db.execute', { sql: 'INSERT INTO items (id, title, tenant_id) VALUES (?, ?, ?)', params: ['i1', 'a', 'EVIL'] });
    expect(r.result).toBe(true);
    expect(runs[0]).toContain('app_hello_items');
    expect(runs[0]).toContain("'T1'");
    expect(runs[0]).not.toContain('EVIL');
  });
  test('table_prefix lấy từ catalog, không tính từ id', async () => {
    const runs: string[] = [];
    const fake = makeFakeHost();
    fake.host.db.run = async (sql) => void runs.push(sql);
    const ctx: BridgeContext = { manifest: manifestWith(ALL), tablePrefix: 'app_vn_app_hello_cal', host: fake.host };
    await handleRpc({ jsonrpc: '2.0', id: 1, method: 'db.execute', params: { sql: 'INSERT INTO items (id) VALUES (?)', params: ['x'] } }, ctx);
    expect(runs[0]).toContain('app_vn_app_hello_cal_items');
  });
  test('db.query chỉ nhận SELECT; db.execute không nhận SELECT', async () => {
    const { call, fake } = setup();
    expect((await call('db.query', { sql: 'DELETE FROM items' })).error?.code).toBe('SQL_REJECTED');
    expect((await call('db.execute', { sql: 'SELECT * FROM items' })).error?.code).toBe('SQL_REJECTED');
    expect(fake.total()).toBe(0);
  });
  test('db.transaction: một câu hỏng thì không câu nào chạy', async () => {
    const { call, fake } = setup();
    const r = await call('db.transaction', {
      statements: [{ sql: 'INSERT INTO items (id) VALUES (?)', params: ['a'] }, { sql: 'DROP TABLE items' }],
    });
    expect(r.error?.code).toBe('SQL_REJECTED');
    expect(fake.total()).toBe(0);
  });
  test('includeDeleted truyền xuống guard', async () => {
    const sqls: string[] = [];
    const { fake, call } = setup();
    fake.host.db.all = async (sql) => (sqls.push(sql), []);
    await call('db.query', { sql: 'SELECT * FROM items', includeDeleted: true });
    await call('db.query', { sql: 'SELECT * FROM items' });
    expect(sqls[0]).not.toContain('deleted_at IS NULL');
    expect(sqls[1]).toContain('deleted_at IS NULL');
  });
});

describe('intent (AC-6)', () => {
  const send = (call: ReturnType<typeof setup>['call'], payload: unknown, extra: Record<string, unknown> = {}) =>
    call('intent.send', { type: 'cal.reminder.create', payload, ...extra });
  test('payload sai schema → INTENT_REJECTED kèm đường dẫn', async () => {
    const { call, fake } = setup();
    const r = await send(call, { title: 'x', at: 'không phải số' });
    expect(r.error?.code).toBe('INTENT_REJECTED');
    expect(r.error?.detail).toBe('/at');
    expect(fake.calls['intent.deliver']).toBeUndefined();
  });
  test('thiếu trường bắt buộc → INTENT_REJECTED', async () => {
    const { call } = setup();
    expect((await send(call, { title: 'x' })).error?.code).toBe('INTENT_REJECTED');
  });
  test('type không khai trong intents.sends → SCOPE_DENIED', async () => {
    const { call, fake } = setup();
    const r = await call('intent.send', { type: 'cal.event.open', payload: {} });
    expect(r.error?.code).toBe('SCOPE_DENIED');
    expect(fake.total()).toBe(0);
  });
  test('không app nào nhận → INTENT_NO_HANDLER', async () => {
    const { call } = setup(ALL, { intents: { sends: [{ type: 'x.unknown', version: '1' }], receives: [] } });
    expect((await call('intent.send', { type: 'x.unknown', payload: {} })).error?.code).toBe('INTENT_NO_HANDLER');
  });
  test('payload > 64 KB → INTENT_REJECTED', async () => {
    const { call } = setup();
    expect((await send(call, { title: 'x'.repeat(70_000), at: 1 })).error?.code).toBe('INTENT_REJECTED');
  });
  test('payload hợp lệ → mode open truyền xuống Host', async () => {
    const { call, fake } = setup();
    const delivered: unknown[] = [];
    fake.host.intent.deliver = async (i) => (delivered.push(i), 'opened');
    const r = await send(call, { title: 'x', at: 1 }, { mode: 'open' });
    expect(r.result).toEqual({ status: 'opened' });
    expect(delivered[0]).toMatchObject({ mode: 'open', to: 'vn.app.hello-cal', type: 'cal.reminder.create' });
  });
  test('gửi cho chính mình → INTENT_REJECTED', async () => {
    const { call, fake } = setup();
    fake.host.intent.receivers = () => [{ appId: 'vn.app.hello', type: 'cal.reminder.create', version: '1', schema: {} }];
    expect((await send(call, { title: 'x', at: 1 })).error?.code).toBe('INTENT_REJECTED');
  });
  test('mode create khi chỉ đọc → READ_ONLY; mode open vẫn được', async () => {
    const { call } = setup(ALL, {}, true);
    expect((await send(call, { title: 'x', at: 1 })).error?.code).toBe('READ_ONLY');
    expect((await send(call, { title: 'x', at: 1 }, { mode: 'open' })).error).toBeUndefined();
  });
});

describe('net (AC-8)', () => {
  test('domain trong danh sách → gọi được', async () => {
    const { call } = setup();
    expect((await call('net.fetch', { url: 'https://example.com/x' })).result).toMatchObject({ status: 200 });
  });
  test.each([
    'https://evil.com/x',
    'https://sub.example.com/x',
    'https://example.com.evil.com/',
    'https://user:pw@example.com/',
    'ftp://example.com/',
    'file:///etc/passwd',
    'https://EXAMPLE.com.evil.io/',
  ])('%s → NET_BLOCKED, Host không bị gọi', async (url) => {
    const { call, fake } = setup();
    const r = await call('net.fetch', { url });
    expect(r.error?.code).toBe('NET_BLOCKED');
    expect(fake.total()).toBe(0);
  });
  test('host khớp không phân biệt hoa thường; wildcard trong manifest không có hiệu lực', async () => {
    expect((await setup().call('net.fetch', { url: 'https://EXAMPLE.com/' })).error).toBeUndefined();
    const w = setup(ALL, { network: ['*.example.com'] });
    expect((await w.call('net.fetch', { url: 'https://a.example.com/' })).error?.code).toBe('NET_BLOCKED');
  });
  test('redirect ra ngoài: Host nhận isAllowed và nó chặn host lạ', async () => {
    const { call, fake } = setup();
    let allowed: boolean | null = null;
    fake.host.net.fetch = async (_r, isAllowed) => {
      allowed = isAllowed('https://evil.com/landing');
      return { status: 200, headers: {}, body: '' };
    };
    await call('net.fetch', { url: 'https://example.com/redir' });
    expect(allowed).toBe(false);
  });
  test('offline: Host ném OFFLINE → mã OFFLINE', async () => {
    const { call, fake } = setup();
    fake.host.net.fetch = async () => {
      throw Object.assign(new Error('Không có mạng'), { code: 'OFFLINE' });
    };
    expect((await call('net.fetch', { url: 'https://example.com/' })).error?.code).toBe('OFFLINE');
  });
  test('tham số sai → INVALID_REQUEST', async () => {
    const { call, fake } = setup();
    expect((await call('net.fetch', { url: 'không phải url' })).error?.code).toBe('INVALID_REQUEST');
    expect((await call('net.fetch', { url: 'https://example.com/', method: 'TRACE' })).error?.code).toBe('INVALID_REQUEST');
    expect(fake.total()).toBe(0);
  });
});

describe('notify / storage / ui / core', () => {
  test('notify.schedule nhận ISO và epoch', async () => {
    const { call, fake } = setup();
    const got: number[] = [];
    fake.host.notify.schedule = async (n) => void got.push(n.at);
    await call('notify.schedule', { id: 'a', at: '2026-10-10T09:00:00.000Z', title: 't' });
    await call('notify.schedule', { id: 'b', at: 1_800_000_000_000, title: 't' });
    expect(got).toEqual([Date.parse('2026-10-10T09:00:00.000Z'), 1_800_000_000_000]);
    expect((await call('notify.schedule', { id: 'c', at: 'không phải ngày', title: 't' })).error?.code).toBe('INVALID_REQUEST');
  });
  test('storage.put từ chối base64 hỏng và mime sai', async () => {
    const { call, fake } = setup();
    expect((await call('storage.put', { name: 'a', mime: 'khong-mime', base64: 'aGk=' })).error?.code).toBe('INVALID_REQUEST');
    expect((await call('storage.put', { name: 'a', mime: 'text/plain', base64: '***' })).error?.code).toBe('INVALID_REQUEST');
    expect(fake.total()).toBe(0);
  });
  test('ui.toast cắt ở 120 ký tự', async () => {
    const { call, fake } = setup();
    const got: string[] = [];
    fake.host.ui.toast = (t) => void got.push(t);
    await call('ui.toast', { text: 'a'.repeat(300) });
    expect(got[0].length).toBe(120);
  });
  test('core.tags.create ghi bằng tenant của phiên', async () => {
    const { call, fake } = setup();
    const runs: unknown[][] = [];
    fake.host.db.run = async (_s, p) => void runs.push(p);
    const r = await call('core.tags.create', { name: ' việc nhà ' });
    expect(r.result).toMatchObject({ name: 'việc nhà' });
    expect(runs[0][1]).toBe('T1');
    expect((await call('core.tags.create', { name: '   ' })).error?.code).toBe('INVALID_REQUEST');
    expect((await call('core.tags.create', { name: 'a', color: 'đỏ' })).error?.code).toBe('INVALID_REQUEST');
  });
  test('core.files.get không có → NOT_FOUND', async () => {
    const { call } = setup();
    expect((await call('core.files.get', { id: 'nope' })).error?.code).toBe('NOT_FOUND');
  });
});

describe('sdk / auth', () => {
  test('sdk.ready gọi lifecycle.ready', async () => {
    const { call, fake } = setup([]);
    await call('sdk.ready');
    expect(fake.calls['lifecycle.ready']).toBe(1);
  });
  test('sdk.info báo readOnly', async () => {
    const { call } = setup([], {}, true);
    expect((await call('sdk.info')).result).toMatchObject({ appId: 'vn.app.hello', sdkVersion: '0.1.0', readOnly: true });
  });
  test('auth.getAppToken dùng app_id của manifest, bỏ qua tham số app truyền', async () => {
    const { call, fake } = setup();
    const ids: string[] = [];
    fake.host.auth.appToken = async (id) => (ids.push(id), { token: 't', expires_at: 1 });
    await call('auth.getAppToken', { app_id: 'vn.evil.app' });
    expect(ids).toEqual(['vn.app.hello']);
  });
  test('offline không có token cache → OFFLINE', async () => {
    const { call, fake } = setup();
    fake.host.auth.appToken = async () => {
      throw Object.assign(new Error('x'), { code: 'OFFLINE' });
    };
    expect((await call('auth.getAppToken')).error?.code).toBe('OFFLINE');
  });
});
