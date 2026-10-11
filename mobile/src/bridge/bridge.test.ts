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
    expect((await call('sdk.info')).result).toMatchObject({ appId: 'vn.app.hello', sdkVersion: '0.1.3', readOnly: true });
  });
  test('sdk.info (SDK 0.1.3) trả tenantId của phiên — muối cho id tất định, không do app khai', async () => {
    const { call } = setup([]);
    expect((await call('sdk.info')).result).toMatchObject({ tenantId: 'T1' });
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

// ---------------- SDK 0.1.2 (vòng 6) ----------------
const W6 = [...ALL, 'net.user-approved'];
function setup6(opts: Parameters<typeof makeFakeHost>[0] = {}, scopes = W6, over: Partial<ReturnType<typeof manifestWith>> = {}) {
  const fake = makeFakeHost(opts);
  const ctx: BridgeContext = { manifest: { ...manifestWith(scopes), ...over }, tablePrefix: 'app_hello', host: fake.host };
  const call = (method: string, params?: RpcRequest['params']) => handleRpc({ jsonrpc: '2.0', id: 1, method, params }, ctx);
  return { fake, call };
}

describe('sdk.info().config (AC-6)', () => {
  test('trả đúng object cấu hình từ Host; chưa có → {}', async () => {
    expect((await setup6({ config: { network: ['a.vn'], sources: [1] } }).call('sdk.info')).result).toMatchObject({ sdkVersion: '0.1.3', config: { network: ['a.vn'], sources: [1] } });
    expect((await setup6().call('sdk.info')).result).toMatchObject({ config: {} });
  });
});

describe('net.requestAccess (AC-5)', () => {
  test('host chưa được phép → Host hỏi đúng 1 lần với host + lý do; Cho phép → granted true', async () => {
    const asked: unknown[] = [];
    const { call, fake } = setup6();
    fake.host.net.requestAccess = async (h, r) => (asked.push([h, r]), true);
    expect((await call('net.requestAccess', { host: 'blog.example.dev', reason: 'Để tải tin' })).result).toEqual({ granted: true });
    expect(asked).toEqual([['blog.example.dev', 'Để tải tin']]);
  });
  test('Không cho phép → {granted:false}, không lỗi', async () => {
    const r = await setup6({ grantAnswer: false }).call('net.requestAccess', { host: 'blog.example.dev' });
    expect(r).toMatchObject({ result: { granted: false } });
    expect(r.error).toBeUndefined();
  });
  test('host đã ∈ manifest.network hoặc extraHosts (config/grant) → true, KHÔNG hỏi', async () => {
    const a = setup6();
    expect((await a.call('net.requestAccess', { host: 'example.com' })).result).toEqual({ granted: true });
    expect(a.fake.calls['net.requestAccess']).toBeUndefined();
    const b = setup6({ extraHosts: ['vnexpress.net'] });
    expect((await b.call('net.requestAccess', { host: 'vnexpress.net' })).result).toEqual({ granted: true });
    expect(b.fake.calls['net.requestAccess']).toBeUndefined();
  });
  test('app nền → {granted:false}, hộp thoại không mở', async () => {
    const { call, fake } = setup6({ foreground: false });
    expect((await call('net.requestAccess', { host: 'blog.example.dev' })).result).toEqual({ granted: false });
    expect(fake.calls['net.requestAccess']).toBeUndefined();
  });
  test('tenant chỉ đọc vẫn được hỏi (grant không phải dữ liệu nghiệp vụ)', async () => {
    const { call, fake } = setup6({ readOnly: true });
    expect((await call('net.requestAccess', { host: 'blog.example.dev' })).result).toEqual({ granted: true });
    expect(fake.calls['net.requestAccess']).toBe(1);
  });
  test.each([
    ['chữ hoa', 'Blog.example.dev'], ['wildcard', '*.example.dev'], ['có scheme', 'https://blog.example.dev'], ['có path', 'blog.example.dev/rss'],
    ['user:pass@', 'u:p@blog.example.dev'], ['cổng quá lớn', 'blog.example.dev:99999'], ['cổng 0', 'a.vn:0'], ['rỗng', ''], ['khoảng trắng', 'a b.vn'],
    ['dấu chấm đầu', '.a.vn'], ['IPv6', '[::1]'], ['quá dài', `${'a'.repeat(251)}.vn`],
  ])('host %s → INVALID_REQUEST, không hỏi', async (_n, host) => {
    const { call, fake } = setup6();
    expect((await call('net.requestAccess', { host })).error?.code).toBe('INVALID_REQUEST');
    expect(fake.total()).toBe(0);
  });
  test('reason > 120 ký tự hoặc sai kiểu → INVALID_REQUEST; host thiếu → INVALID_REQUEST', async () => {
    const { call, fake } = setup6();
    expect((await call('net.requestAccess', { host: 'a.vn', reason: 'x'.repeat(121) })).error?.code).toBe('INVALID_REQUEST');
    expect((await call('net.requestAccess', { host: 'a.vn', reason: 5 as unknown as string })).error?.code).toBe('INVALID_REQUEST');
    expect((await call('net.requestAccess', {})).error?.code).toBe('INVALID_REQUEST');
    expect(fake.total()).toBe(0);
  });
  test('thiếu net.user-approved (dù có net) hoặc thiếu net → SCOPE_DENIED, 0 lời gọi', async () => {
    const a = setup6({}, ALL);
    expect((await a.call('net.requestAccess', { host: 'a.vn' })).error?.code).toBe('SCOPE_DENIED');
    const b = setup6({}, ['net.user-approved', 'ui.native']);
    expect((await b.call('net.requestAccess', { host: 'a.vn' })).error?.code).toBe('SCOPE_DENIED');
    expect(a.fake.total() + b.fake.total()).toBe(0);
  });
  test('lý do rỗng/khoảng trắng → Host nhận null (dùng câu mặc định)', async () => {
    const got: unknown[] = [];
    const { call, fake } = setup6();
    fake.host.net.requestAccess = async (_h, r) => (got.push(r), false);
    await call('net.requestAccess', { host: 'a.vn', reason: '   ' });
    await call('net.requestAccess', { host: 'a.vn' });
    expect(got).toEqual([null, null]);
  });
});

describe('net.fetch với whitelist mở rộng (AC-5)', () => {
  test('host trong extraHosts (grant/config) gọi được; host ngoài vẫn NET_BLOCKED', async () => {
    const { call } = setup6({ extraHosts: ['blog.example.dev', '10.0.2.2:8787'] });
    expect((await call('net.fetch', { url: 'https://blog.example.dev/rss' })).error).toBeUndefined();
    expect((await call('net.fetch', { url: 'http://10.0.2.2:8787/feed.xml' })).error).toBeUndefined();
    expect((await call('net.fetch', { url: 'http://10.0.2.2:9999/feed.xml' })).error?.code).toBe('NET_BLOCKED');
    expect((await call('net.fetch', { url: 'https://example.dev/' })).error?.code).toBe('NET_BLOCKED');
    expect((await call('net.fetch', { url: 'https://evil.com/' })).error?.code).toBe('NET_BLOCKED');
  });
  test('grant của host không mở sang cổng khác hay subdomain; mục có cổng chỉ khớp đúng cổng', async () => {
    const { call } = setup6({ extraHosts: ['a.vn'] });
    expect((await call('net.fetch', { url: 'https://a.vn:8443/x' })).error?.code).toBe('NET_BLOCKED');
    expect((await call('net.fetch', { url: 'https://a.vn:443/x' })).error).toBeUndefined();
    expect((await call('net.fetch', { url: 'https://www.a.vn/x' })).error?.code).toBe('NET_BLOCKED');
  });
  test('thu hồi giữa chừng: isAllowed đọc lại extraHosts ở mỗi bước chuyển hướng', async () => {
    const hosts = ['blog.example.dev'];
    const { call, fake } = setup6();
    fake.host.net.extraHosts = () => hosts;
    const seen: boolean[] = [];
    fake.host.net.fetch = async (_r, isAllowed) => {
      seen.push(isAllowed('https://blog.example.dev/hop1'));
      hosts.length = 0; // thu hồi ở S4 trong lúc request đang bay
      seen.push(isAllowed('https://blog.example.dev/hop2'));
      return { status: 200, headers: {}, body: '' };
    };
    await call('net.fetch', { url: 'https://blog.example.dev/rss' });
    expect(seen).toEqual([true, false]);
    expect((await call('net.fetch', { url: 'https://blog.example.dev/rss' })).error?.code).toBe('NET_BLOCKED');
  });
});

describe('ui.openUrl (AC-6)', () => {
  test('http(s) hợp lệ → Host mở đúng URL; không qua whitelist mạng', async () => {
    const opened: string[] = [];
    const { call, fake } = setup6();
    fake.host.ui.openUrl = async (u) => void opened.push(u);
    expect((await call('ui.openUrl', { url: 'https://other.example.org/a?b=1#c' })).result).toBe(true);
    expect((await call('ui.openUrl', { url: 'http://10.0.2.2:8787/bai.html' })).result).toBe(true);
    expect(opened).toEqual(['https://other.example.org/a?b=1#c', 'http://10.0.2.2:8787/bai.html']);
  });
  test.each([
    ['javascript:', 'javascript:alert(1)'], ['intent:', 'intent://x#Intent;scheme=a;end'], ['file:', 'file:///etc/passwd'], ['ftp:', 'ftp://a.vn/x'],
    ['data:', 'data:text/html,hi'], ['không phải URL', 'abc'], ['user:pass@', 'https://u:p@a.vn/'], ['quá dài', `https://a.vn/${'x'.repeat(2100)}`],
  ])('%s → INVALID_REQUEST, Host không bị gọi', async (_n, url) => {
    const { call, fake } = setup6();
    expect((await call('ui.openUrl', { url })).error?.code).toBe('INVALID_REQUEST');
    expect(fake.total()).toBe(0);
  });
  test('app nền → APP_SUSPENDED, Host không bị gọi; thiếu ui.native → SCOPE_DENIED', async () => {
    const a = setup6({ foreground: false });
    expect((await a.call('ui.openUrl', { url: 'https://a.vn/' })).error?.code).toBe('APP_SUSPENDED');
    expect(a.fake.total()).toBe(0);
    const b = setup6({}, ['net']);
    expect((await b.call('ui.openUrl', { url: 'https://a.vn/' })).error?.code).toBe('SCOPE_DENIED');
    expect(b.fake.total()).toBe(0);
  });
  test('chỉ đọc vẫn mở được (đọc báo khi hết ân hạn)', async () => {
    expect((await setup6({ readOnly: true }).call('ui.openUrl', { url: 'https://a.vn/' })).result).toBe(true);
  });
});
