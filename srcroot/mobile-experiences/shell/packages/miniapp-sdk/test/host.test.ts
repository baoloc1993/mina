// Host của mock SDK chạy dưới handleRpc THẬT của shell: DB (node:sqlite thay SQLite WASM), net, intent, file, chỉ đọc.
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { handleRpc, type BridgeContext, type Manifest, type RpcResponse } from '../../../src/bridge/bridge';
import { createTabBus, type TabBus } from '../mock/src/bus';
import { inferTablePrefix, prepareDatabase } from '../mock/src/db';
import { createMockHost, type HopFetch, type NetMode } from '../mock/src/host';
import { loadFixture } from '../mock/plugin';
import { openNodeDb } from './nodeDriver';

const FIX = join(__dirname, '../../../fixtures');
let seq = 0;
const buses: TabBus[] = [];

interface Rig {
  call(method: string, params?: Record<string, unknown>): Promise<RpcResponse>;
  db: ReturnType<typeof openNodeDb>;
  bus: TabBus;
  manifest: Manifest;
  setNet(m: NetMode): void;
  hops: string[];
  setHop(fn: HopFetch): void;
  notes: string[];
  mock: ReturnType<typeof createMockHost>;
  prefix: string;
}

function rig(fixture: string, opts: { channel?: string } = {}): Rig {
  const fx = loadFixture(join(FIX, fixture));
  const manifest: Manifest = fx.manifest;
  const prefix = inferTablePrefix(manifest, fx.migrations);
  const db = openNodeDb();
  prepareDatabase(db, manifest, prefix, fx.migrations);
  let net: NetMode = 'online';
  const hops: string[] = [];
  let hop: HopFetch = async (r) => (hops.push(r.url), { status: 200, headers: {}, body: 'ok' });
  const notes: string[] = [];
  const bus = createTabBus(() => manifest, opts.channel ?? `test-${Date.now()}-${seq++}`);
  buses.push(bus);
  const mock = createMockHost({
    manifest: () => manifest,
    driver: db,
    hopFetch: (r) => hop(r),
    bus,
    netMode: () => net,
    callbacks: { onNotify: (n, phase) => notes.push(`${phase}:${n.id}`), onToast: (t) => notes.push(`toast:${t}`) },
  });
  const ctx: BridgeContext = { manifest, tablePrefix: prefix, host: mock.host };
  return {
    call: (method, params) => handleRpc({ jsonrpc: '2.0', id: 1, method, params }, ctx),
    db,
    bus,
    manifest,
    setNet: (m) => void (net = m),
    hops,
    setHop: (fn) => void (hop = async (r) => (hops.push(r.url), fn(r))),
    notes,
    mock,
    prefix,
  };
}

afterEach(() => {
  while (buses.length) buses.pop()!.close();
});

const ok = (r: RpcResponse) => {
  expect(r.error, JSON.stringify(r.error)).toBeUndefined();
  return r.result as any;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('schema + tiền tố bảng', () => {
  test('suy tiền tố từ migration; mặc định theo id khi không có', () => {
    const hello = loadFixture(join(FIX, 'miniapp-hello'));
    const cal = loadFixture(join(FIX, 'miniapp-hello-cal'));
    expect(inferTablePrefix(hello.manifest, hello.migrations)).toBe('app_hello');
    expect(inferTablePrefix(cal.manifest, cal.migrations)).toBe('app_vn_app_hello_cal');
    expect(inferTablePrefix(cal.manifest, [])).toBe('app_vn_app_hello_cal');
  });

  test('migration chạy một lần, thêm cột hệ thống thiếu, chạy lại không đổi gì', () => {
    const fx = loadFixture(join(FIX, 'miniapp-hello'));
    const db = openNodeDb();
    const a = prepareDatabase(db, fx.manifest, 'app_hello', fx.migrations);
    expect(a.applied).toEqual(['001_init.sql']);
    expect(a.addedColumns).toContain('app_hello_items.tenant_id');
    expect(a.addedColumns).toContain('app_hello_drafts.deleted_at');
    const cols = db.all('PRAGMA table_info(app_hello_items)', []).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['id', 'title', 'done', 'tenant_id', 'created_at', 'updated_at', 'deleted_at']));
    const b = prepareDatabase(db, fx.manifest, 'app_hello', fx.migrations);
    expect(b.applied).toEqual([]);
    expect(b.skipped).toEqual(['001_init.sql']);
    expect(b.addedColumns).toEqual([]);
  });

  test('migration lỗi → ném lỗi nêu tên file, không để lại dấu vết', () => {
    const fx = loadFixture(join(FIX, 'miniapp-hello'));
    const db = openNodeDb();
    expect(() => prepareDatabase(db, fx.manifest, 'app_hello', [{ name: '009_bad.sql', sql: 'CREATE TABLE app_hello_items (id text); SELEC nonsense;' }])).toThrow(/009_bad\.sql/);
    expect(db.all("SELECT name FROM sqlite_master WHERE name = 'app_hello_items'", [])).toEqual([]);
  });
});

describe('db qua guard (xoá mềm, lọc deleted_at)', () => {
  test('INSERT → SELECT → DELETE xoá mềm; SELECT tự lọc, includeDeleted thấy lại', async () => {
    const r = rig('miniapp-hello');
    ok(await r.call('db.execute', { sql: 'INSERT INTO items (id, title, done) VALUES (?, ?, ?)', params: ['a', 'Mục A', 0] }));
    ok(await r.call('db.execute', { sql: 'INSERT INTO items (id, title, done) VALUES (?, ?, ?)', params: ['b', 'Mục B', 0] }));
    expect(ok(await r.call('db.query', { sql: 'SELECT id, title FROM items ORDER BY id', params: [] }))).toEqual([
      { id: 'a', title: 'Mục A' },
      { id: 'b', title: 'Mục B' },
    ]);
    ok(await r.call('db.execute', { sql: 'DELETE FROM items WHERE id = ?', params: ['a'] }));
    // SELECT thường tự lọc dòng đã xoá mềm — kể cả khi app không viết deleted_at IS NULL
    expect(ok(await r.call('db.query', { sql: 'SELECT id FROM items', params: [] }))).toEqual([{ id: 'b' }]);
    expect(ok(await r.call('db.query', { sql: 'SELECT id FROM items ORDER BY id', params: [], includeDeleted: true })).map((x: any) => x.id)).toEqual(['a', 'b']);
    // vật lý: dòng còn đó, chỉ có deleted_at
    const raw = r.db.all('SELECT id, deleted_at, tenant_id FROM app_hello_items ORDER BY id', []);
    expect(raw).toHaveLength(2);
    expect(raw[0].deleted_at).toEqual(expect.any(String));
    expect(raw[1].deleted_at).toBeNull();
    expect(raw[0].tenant_id).toBe('mock-tenant');
  });

  test('app không ghi đè được cột hệ thống; SQL ngoài phạm vi bị chặn', async () => {
    const r = rig('miniapp-hello');
    ok(await r.call('db.execute', { sql: 'INSERT INTO items (id, title, tenant_id, created_at) VALUES (?, ?, ?, ?)', params: ['x', 'T', 'tenant-khac', '1999-01-01'] }).then((x) => x));
    const row = r.db.all('SELECT tenant_id, created_at FROM app_hello_items WHERE id = ?', ['x'])[0];
    expect(row.tenant_id).toBe('mock-tenant');
    expect(row.created_at).not.toBe('1999-01-01');
    for (const sql of ['SELECT * FROM secrets', 'DROP TABLE items', "ATTACH DATABASE 'x.db' AS x", 'PRAGMA key = 1']) {
      expect((await r.call('db.execute', { sql, params: [] })).error?.code, sql).toMatch(/SQL_REJECTED|INVALID_REQUEST/);
    }
    expect((await r.call('db.query', { sql: 'SELECT * FROM secrets', params: [] })).error?.code).toBe('SQL_REJECTED');
  });

  test('transaction: một câu hỏng thì không câu nào chạy', async () => {
    const r = rig('miniapp-hello');
    const bad = await r.call('db.transaction', {
      statements: [
        { sql: 'INSERT INTO items (id, title) VALUES (?, ?)', params: ['t1', 'ok'] },
        { sql: 'INSERT INTO items (id, title) VALUES (?, ?)', params: ['t1', 'trùng khoá'] }, // PRIMARY KEY trùng → lỗi lúc chạy
      ],
    });
    expect(bad.error).toBeDefined();
    expect(ok(await r.call('db.query', { sql: 'SELECT id FROM items', params: [] }))).toEqual([]);
    ok(await r.call('db.transaction', { statements: [{ sql: 'INSERT INTO items (id, title) VALUES (?, ?)', params: ['t2', 'ok'] }] }));
    expect(ok(await r.call('db.query', { sql: 'SELECT id FROM items', params: [] }))).toEqual([{ id: 't2' }]);
  });

  test('nháp: ghi bảng drafts rồi đọc lại (AC-14)', async () => {
    const r = rig('miniapp-hello');
    ok(await r.call('db.execute', { sql: 'INSERT INTO drafts (id, value) VALUES (?, ?)', params: ['main', 'dở dang'] }));
    ok(await r.call('db.execute', { sql: 'UPDATE drafts SET value = ? WHERE id = ?', params: ['dở dang hơn', 'main'] }));
    expect(ok(await r.call('db.query', { sql: 'SELECT value FROM drafts WHERE id = ?', params: ['main'] }))).toEqual([{ value: 'dở dang hơn' }]);
  });
});

describe('core.tags / core.contacts', () => {
  test('core.tags.create → core.tags.list; thiếu scope core.contacts → SCOPE_DENIED', async () => {
    const r = rig('miniapp-hello');
    const t = ok(await r.call('core.tags.create', { name: 'việc nhà' }));
    expect(t.name).toBe('việc nhà');
    expect(ok(await r.call('core.tags.list'))).toEqual([{ id: t.id, name: 'việc nhà', color: null }]);
    expect((await r.call('core.contacts.create', { name: 'An' })).error?.code).toBe('SCOPE_DENIED');
    expect((await r.call('core.tags.create', { name: '   ' })).error?.code).toBe('INVALID_REQUEST');
  });
});

describe('net: whitelist ở URL đầu và mọi bước chuyển hướng', () => {
  test('host trong danh sách → chạy; domain lạ → NET_BLOCKED và KHÔNG gửi request', async () => {
    const r = rig('miniapp-hello');
    expect(ok(await r.call('net.fetch', { url: 'https://vnexpress.net/' })).status).toBe(200);
    expect(r.hops).toEqual(['https://vnexpress.net/']);
    const bad = await r.call('net.fetch', { url: 'https://example.org/' });
    expect(bad.error?.code).toBe('NET_BLOCKED');
    expect(bad.error?.detail).toBe('example.org');
    expect((await r.call('net.fetch', { url: 'https://sub.vnexpress.net/' })).error?.code).toBe('NET_BLOCKED'); // không subdomain
    expect(r.hops).toHaveLength(1);
  });

  test('chuyển hướng ra domain ngoài → NET_BLOCKED, request tới domain lạ không bao giờ được gửi', async () => {
    const r = rig('miniapp-hello');
    r.setHop(async (req) =>
      req.url === 'https://vnexpress.net/' ? { status: 302, headers: { location: 'https://evil.example/steal' }, body: '' } : { status: 200, headers: {} as Record<string, string>, body: 'lọt' },
    );
    const res = await r.call('net.fetch', { url: 'https://vnexpress.net/' });
    expect(res.error?.code).toBe('NET_BLOCKED');
    expect(res.error?.detail).toBe('evil.example');
    expect(r.hops).toEqual(['https://vnexpress.net/']);
  });

  test('chuyển hướng tương đối trong cùng host được theo; vòng lặp > 5 bước → NET_ERROR', async () => {
    const r = rig('miniapp-hello');
    r.setHop(async (req) => (req.url.endsWith('/a') ? { status: 301, headers: { location: '/b' }, body: '' } : { status: 200, headers: {} as Record<string, string>, body: 'xong' }));
    const res = ok(await r.call('net.fetch', { url: 'https://vnexpress.net/a' }));
    expect(res.body).toBe('xong');
    expect(r.hops).toEqual(['https://vnexpress.net/a', 'https://vnexpress.net/b']);
    const loop = rig('miniapp-hello');
    loop.setHop(async () => ({ status: 302, headers: { location: '/again' }, body: '' }));
    expect((await loop.call('net.fetch', { url: 'https://vnexpress.net/' })).error?.code).toBe('NET_ERROR');
  });

  test('offline → OFFLINE không gửi; lỗi mạng → NET_ERROR', async () => {
    const r = rig('miniapp-hello');
    r.setNet('offline');
    expect((await r.call('net.fetch', { url: 'https://vnexpress.net/' })).error?.code).toBe('OFFLINE');
    expect(r.hops).toHaveLength(0);
    r.setNet('online');
    r.setHop(async () => {
      throw new Error('ECONNRESET');
    });
    expect((await r.call('net.fetch', { url: 'https://vnexpress.net/' })).error?.code).toBe('NET_ERROR');
  });
});

describe('intent giữa hai tab', () => {
  test('hello gửi, hello-cal nhận qua BroadcastChannel; payload sai và type lạ bị chặn', async () => {
    const channel = `ch-${Date.now()}`;
    const hello = rig('miniapp-hello', { channel });
    const cal = rig('miniapp-hello-cal', { channel });
    const got: any[] = [];
    cal.bus.onIntent((m) => (got.push(m), true));
    hello.bus.announce(hello.manifest);
    cal.bus.announce(cal.manifest);
    await sleep(60);

    const sent = ok(await hello.call('intent.send', { type: 'cal.reminder.create', payload: { title: 'Gọi mẹ', at: 1_800_000_000_000 }, mode: 'create' }));
    expect(sent).toEqual({ status: 'handled' });
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ type: 'cal.reminder.create', version: '1', from: 'vn.app.hello', to: 'vn.app.hello-cal', mode: 'create', payload: { title: 'Gọi mẹ' } });

    const open = ok(await hello.call('intent.send', { type: 'cal.event.open', payload: { title: 'x' }, mode: 'open' }));
    expect(open).toEqual({ status: 'opened' });

    const badPayload = await hello.call('intent.send', { type: 'cal.reminder.create', payload: { title: 123, at: 1 }, mode: 'create' });
    expect(badPayload.error?.code).toBe('INTENT_REJECTED');
    expect(badPayload.error?.detail).toBe('/title');
    const extra = await hello.call('intent.send', { type: 'cal.reminder.create', payload: { title: 'x', at: 1, evil: true }, mode: 'create' });
    expect(extra.error?.code).toBe('INTENT_REJECTED');
    expect((await hello.call('intent.send', { type: 'cal.khong.khai', payload: {}, mode: 'create' })).error?.code).toBe('SCOPE_DENIED');
    expect(got).toHaveLength(2); // hai lần gửi sai không tới được app nhận
  });

  test('không có tab nhận → INTENT_NO_HANDLER; chỉ đọc + create → READ_ONLY; app nhận không xử lý → queued', async () => {
    const channel = `ch-${Date.now()}-b`;
    const hello = rig('miniapp-hello', { channel });
    await sleep(30);
    expect((await hello.call('intent.send', { type: 'cal.reminder.create', payload: { title: 'a', at: 1 }, mode: 'create' })).error?.code).toBe('INTENT_NO_HANDLER');

    const cal = rig('miniapp-hello-cal', { channel });
    cal.bus.onIntent(() => false); // iframe chưa nạp xong → shell xếp hàng
    cal.bus.announce(cal.manifest);
    await sleep(60);
    expect(ok(await hello.call('intent.send', { type: 'cal.reminder.create', payload: { title: 'a', at: 1 }, mode: 'create' }))).toEqual({ status: 'queued' });
    hello.setNet('ro');
    expect((await hello.call('intent.send', { type: 'cal.reminder.create', payload: { title: 'a', at: 1 }, mode: 'create' })).error?.code).toBe('READ_ONLY');
    expect(ok(await hello.call('intent.send', { type: 'cal.event.open', payload: {}, mode: 'open' }))).toEqual({ status: 'queued' }); // open vẫn được khi chỉ đọc
  });
});

describe('file, notify, sync, chỉ đọc', () => {
  test('storage.put ghi core_files; core.files.list/get thấy; remove → NOT_FOUND', async () => {
    const r = rig('miniapp-hello-cal');
    const f = ok(await r.call('storage.put', { name: 'a.txt', mime: 'text/plain', base64: 'aGk=' }));
    expect(f.status).toBe('local');
    expect(f.uri).toBe('data:text/plain;base64,aGk=');
    const list = ok(await r.call('core.files.list'));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: f.fileId, app_id: 'vn.app.hello-cal', name: 'a.txt', size: 2 });
    expect(ok(await r.call('core.files.get', { id: f.fileId })).name).toBe('a.txt');
    ok(await r.call('storage.remove', { fileId: f.fileId }));
    expect((await r.call('storage.get', { fileId: f.fileId })).error?.code).toBe('NOT_FOUND');
    expect(ok(await r.call('core.files.list'))).toEqual([]);
    expect((await r.call('storage.put', { name: 'a', mime: 'khong-hop-le', base64: 'aGk=' })).error?.code).toBe('INVALID_REQUEST');
  });

  test('notify.schedule: at trong quá khứ kêu ngay; cancel; list', async () => {
    const r = rig('miniapp-hello-cal');
    ok(await r.call('notify.schedule', { id: 'n1', at: Date.now() - 1000, title: 'Quá khứ' }));
    await sleep(20);
    expect(r.notes).toEqual(['scheduled:n1', 'fired:n1']);
    ok(await r.call('notify.schedule', { id: 'n2', at: Date.now() + 3_600_000, title: 'Sau' }));
    expect(ok(await r.call('notify.list'))).toHaveLength(1);
    ok(await r.call('notify.cancel', { id: 'n2' }));
    expect(ok(await r.call('notify.list'))).toEqual([]);
    expect(r.notes.at(-1)).toBe('cancelled:n2');
  });

  test('ui.toast, sdk.info, auth.getAppToken', async () => {
    const r = rig('miniapp-hello');
    ok(await r.call('ui.toast', { text: 'xin chào' }));
    expect(r.notes).toContain('toast:xin chào');
    expect(ok(await r.call('sdk.info'))).toMatchObject({ appId: 'vn.app.hello', version: expect.stringMatching(/^\d+\.\d+\.\d+$/), sdkVersion: '0.1.1', platform: 'mock-web', readOnly: false });
    expect(ok(await r.call('auth.getAppToken')).token).toContain('vn.app.hello');
    // hello không khai notify.local
    expect((await r.call('notify.schedule', { id: 'x', at: 1, title: 'x' })).error?.code).toBe('SCOPE_DENIED');
  });

  test('chỉ đọc: ghi → READ_ONLY (không đổi DB), đọc vẫn được, sdk.info báo readOnly', async () => {
    const r = rig('miniapp-hello');
    r.setNet('ro');
    expect((await r.call('db.execute', { sql: 'INSERT INTO items (id, title) VALUES (?, ?)', params: ['a', 'x'] })).error?.code).toBe('READ_ONLY');
    expect(r.db.all('SELECT COUNT(*) AS n FROM app_hello_items', [])[0].n).toBe(0);
    expect(ok(await r.call('db.query', { sql: 'SELECT id FROM items', params: [] }))).toEqual([]);
    expect(ok(await r.call('sdk.info')).readOnly).toBe(true);
  });

  test('sync.status theo công tắc; offline đếm thay đổi chờ gửi', async () => {
    const r = rig('miniapp-hello');
    expect(ok(await r.call('sync.status'))).toMatchObject({ state: 'online', pending: 0 });
    r.setNet('offline');
    ok(await r.call('db.execute', { sql: 'INSERT INTO items (id, title) VALUES (?, ?)', params: ['a', 'x'] }));
    ok(await r.call('db.execute', { sql: 'INSERT INTO items (id, title) VALUES (?, ?)', params: ['b', 'y'] }));
    expect(ok(await r.call('sync.status'))).toMatchObject({ state: 'offline', pending: 2 });
    r.setNet('online');
    r.mock.resetPending();
    expect(ok(await r.call('sync.status'))).toMatchObject({ state: 'online', pending: 0 });
  });
});
