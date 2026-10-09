// SDK 0.1.2 (vòng 6) trên mock SDK dưới handleRpc THẬT của shell: net.requestAccess + grant (core_net_grants), net.fetch với whitelist mở rộng,
// ui.openUrl, sdk.info().config, sự kiện `config`. Cùng bảng kỳ vọng với Jest của shell.
import { afterEach, describe, expect, test } from 'vitest';
import { Window } from 'happy-dom';
import { handleRpc, type BridgeContext, type Manifest, type RpcResponse } from '../../../src/bridge/bridge';
import { createTabBus, type TabBus } from '../mock/src/bus';
import { prepareDatabase } from '../mock/src/db';
import { createMockHost, type HopFetch, type NetMode } from '../mock/src/host';
import { INJECTED_SDK } from '../src/injected';
import { openNodeDb } from './nodeDriver';

const buses: TabBus[] = [];
afterEach(() => {
  while (buses.length) buses.pop()!.close();
});

const MANIFEST: Manifest = {
  id: 'vn.app.news', name: 'Đọc báo', version: '0.1.0', sdk: '^0.1.2', entry: 'index.html',
  scopes: ['db.own', 'net', 'net.user-approved', 'ui.native'], tables: ['sources'], network: [],
};

function rig(opts: { config?: Record<string, unknown>; answer?: boolean | (() => boolean); foreground?: boolean } = {}) {
  const db = openNodeDb();
  prepareDatabase(db, MANIFEST, 'app_vn_app_news', [{ name: '001.sql', sql: 'CREATE TABLE IF NOT EXISTS app_vn_app_news_sources (id text PRIMARY KEY, name text);' }]);
  let net: NetMode = 'online';
  const hops: string[] = [];
  let hop: HopFetch = async (r) => (hops.push(r.url), { status: 200, headers: {}, body: '<rss/>' });
  const asked: { host: string; reason: string | null }[] = [];
  const opened: string[] = [];
  const bus = createTabBus(() => MANIFEST, `net6-${Date.now()}-${Math.random()}`);
  buses.push(bus);
  const mock = createMockHost({
    manifest: () => MANIFEST,
    driver: db,
    hopFetch: (r) => hop(r),
    bus,
    netMode: () => net,
    config: () => opts.config ?? {},
    foreground: () => opts.foreground ?? true,
    callbacks: {
      confirmAccess: async (host, reason) => {
        asked.push({ host, reason });
        return typeof opts.answer === 'function' ? opts.answer() : (opts.answer ?? true);
      },
      openUrl: (u) => void opened.push(u),
    },
  });
  const ctx: BridgeContext = { manifest: MANIFEST, tablePrefix: 'app_vn_app_news', host: mock.host };
  const call = (method: string, params?: Record<string, unknown>): Promise<RpcResponse> => handleRpc({ jsonrpc: '2.0', id: 1, method, params }, ctx);
  return { call, db, asked, opened, hops, setNet: (m: NetMode) => void (net = m), setHop: (f: HopFetch) => void (hop = async (r) => (hops.push(r.url), f(r))) };
}

const grants = (db: ReturnType<typeof openNodeDb>) => db.all('SELECT host, deleted_at FROM core_net_grants ORDER BY created_at, host', []);

describe('net.requestAccess trên mock', () => {
  test('Cho phép → ghi core_net_grants; fetch host đó được; host khác vẫn NET_BLOCKED', async () => {
    const r = rig();
    expect((await r.call('net.fetch', { url: 'https://blog.example.dev/rss' })).error?.code).toBe('NET_BLOCKED');
    expect((await r.call('net.requestAccess', { host: 'blog.example.dev', reason: 'Để tải tin' })).result).toEqual({ granted: true });
    expect(r.asked).toEqual([{ host: 'blog.example.dev', reason: 'Để tải tin' }]);
    expect(grants(r.db)).toEqual([{ host: 'blog.example.dev', deleted_at: null }]);
    expect((await r.call('net.fetch', { url: 'https://blog.example.dev/rss' })).error).toBeUndefined();
    expect((await r.call('net.fetch', { url: 'https://other.dev/rss' })).error?.code).toBe('NET_BLOCKED');
  });
  test('hỏi lại host đã được phép → không hỏi, không ghi thêm dòng', async () => {
    const r = rig();
    await r.call('net.requestAccess', { host: 'blog.example.dev' });
    expect((await r.call('net.requestAccess', { host: 'blog.example.dev' })).result).toEqual({ granted: true });
    expect(r.asked).toHaveLength(1);
    expect(grants(r.db)).toHaveLength(1);
  });
  test('Không → {granted:false}, không ghi dòng, fetch vẫn NET_BLOCKED, hỏi lại được ở lần sau', async () => {
    let yes = false;
    const r = rig({ answer: () => yes });
    expect((await r.call('net.requestAccess', { host: 'blog.example.dev' })).result).toEqual({ granted: false });
    expect(grants(r.db)).toEqual([]);
    expect((await r.call('net.fetch', { url: 'https://blog.example.dev/' })).error?.code).toBe('NET_BLOCKED');
    yes = true;
    expect((await r.call('net.requestAccess', { host: 'blog.example.dev' })).result).toEqual({ granted: true });
    expect(r.asked).toHaveLength(2);
  });
  test('host ∈ config.network → granted không hỏi, không ghi; fetch được', async () => {
    const r = rig({ config: { network: ['vnexpress.net'] } });
    expect((await r.call('net.requestAccess', { host: 'vnexpress.net' })).result).toEqual({ granted: true });
    expect(r.asked).toEqual([]);
    expect(grants(r.db)).toEqual([]);
    expect((await r.call('net.fetch', { url: 'https://vnexpress.net/rss/tin-moi-nhat.rss' })).error).toBeUndefined();
  });
  test('thu hồi (xoá mềm) → lần fetch sau NET_BLOCKED; cho phép lại ghi dòng mới', async () => {
    const r = rig();
    await r.call('net.requestAccess', { host: 'blog.example.dev' });
    r.db.run("UPDATE core_net_grants SET deleted_at = '2026-10-09' WHERE host = ?", ['blog.example.dev']);
    expect((await r.call('net.fetch', { url: 'https://blog.example.dev/rss' })).error?.code).toBe('NET_BLOCKED');
    expect((await r.call('net.requestAccess', { host: 'blog.example.dev' })).result).toEqual({ granted: true });
    expect(grants(r.db).filter((g) => g.deleted_at === null)).toHaveLength(1);
  });
  test('redirect sang host chưa được phép → NET_BLOCKED, không request nào rời máy tới host đó', async () => {
    const r = rig();
    await r.call('net.requestAccess', { host: 'a.vn' });
    r.setHop(async (req) => (req.url === 'http://a.vn/rss' ? { status: 301, headers: { location: 'https://www.a.vn/rss' }, body: '' } : { status: 200, headers: {}, body: 'x' }));
    const res = await r.call('net.fetch', { url: 'http://a.vn/rss' });
    expect(res.error?.code).toBe('NET_BLOCKED');
    expect(res.error?.detail).toBe('www.a.vn');
    expect(r.hops).toEqual(['http://a.vn/rss']);
  });
  test('http → https cùng host: được', async () => {
    const r = rig();
    await r.call('net.requestAccess', { host: 'a.vn' });
    r.setHop(async (req) => (req.url.startsWith('http://') ? { status: 301, headers: { location: 'https://a.vn/rss' }, body: '' } : { status: 200, headers: {}, body: 'ok' }));
    expect((await r.call('net.fetch', { url: 'http://a.vn/rss' })).result).toMatchObject({ status: 200, body: 'ok' });
  });
  test('offline vẫn hỏi và ghi được; fetch báo OFFLINE (không phải NET_BLOCKED)', async () => {
    const r = rig();
    r.setNet('offline');
    expect((await r.call('net.requestAccess', { host: 'a.vn' })).result).toEqual({ granted: true });
    expect((await r.call('net.fetch', { url: 'https://a.vn/rss' })).error?.code).toBe('OFFLINE');
  });
  test('chỉ đọc vẫn hỏi và ghi grant (grant không phải dữ liệu nghiệp vụ)', async () => {
    const r = rig();
    r.setNet('ro');
    expect((await r.call('net.requestAccess', { host: 'a.vn' })).result).toEqual({ granted: true });
    expect(grants(r.db)).toHaveLength(1);
  });
  test('app nền → {granted:false}, không hộp thoại', async () => {
    const r = rig({ foreground: false });
    expect((await r.call('net.requestAccess', { host: 'a.vn' })).result).toEqual({ granted: false });
    expect(r.asked).toEqual([]);
  });
  test('grant của app khác không hưởng: dòng core_net_grants app_id khác không mở cửa', async () => {
    const r = rig();
    r.db.run("INSERT INTO core_net_grants (id, tenant_id, app_id, host) VALUES ('g1', 't', 'vn.app.other', 'a.vn')", []);
    expect((await r.call('net.fetch', { url: 'https://a.vn/x' })).error?.code).toBe('NET_BLOCKED');
  });
});

describe('ui.openUrl + sdk.info().config trên mock', () => {
  test('openUrl: Host nhận đúng URL; không qua whitelist; offline vẫn mở', async () => {
    const r = rig();
    r.setNet('offline');
    expect((await r.call('ui.openUrl', { url: 'https://khong-trong-whitelist.example/a' })).result).toBe(true);
    expect(r.opened).toEqual(['https://khong-trong-whitelist.example/a']);
    expect((await r.call('ui.openUrl', { url: 'javascript:alert(1)' })).error?.code).toBe('INVALID_REQUEST');
    expect(r.opened).toHaveLength(1);
  });
  test('info().config: từ cấu hình; chưa có → {}', async () => {
    expect((await rig({ config: { network: ['a.vn'], sources: [{ key: 'vne' }] } }).call('sdk.info')).result).toMatchObject({ sdkVersion: '0.1.2', config: { network: ['a.vn'], sources: [{ key: 'vne' }] } });
    expect((await rig().call('sdk.info')).result).toMatchObject({ config: {} });
  });
});

describe('INJECTED_SDK 0.1.2', () => {
  function env() {
    const win: any = new Window({ url: 'https://app.test/' });
    const sent: { id: number; method: string; params: Record<string, unknown> }[] = [];
    win.__miniappTransport = (s: string) => sent.push(JSON.parse(s));
    win.eval(INJECTED_SDK);
    return { win, sent, m: win.miniapp };
  }
  test('net.requestAccess / ui.openUrl gửi đúng method + tham số', async () => {
    const { win, sent, m } = env();
    const a = m.net.requestAccess({ host: 'a.vn', reason: 'vì sao' });
    const b = m.ui.openUrl('https://a.vn/x');
    expect(sent.map((s) => [s.method, s.params])).toEqual([
      ['net.requestAccess', { host: 'a.vn', reason: 'vì sao' }],
      ['ui.openUrl', { url: 'https://a.vn/x' }],
    ]);
    win.__miniappResolve(JSON.stringify({ jsonrpc: '2.0', id: sent[0].id, result: { granted: true } }));
    win.__miniappResolve(JSON.stringify({ jsonrpc: '2.0', id: sent[1].id, result: true }));
    expect(await a).toEqual({ granted: true });
    expect(await b).toBe(true);
  });
  test('sdk.on("config") nhận object cấu hình mới; huỷ đăng ký được', () => {
    const { win, m } = env();
    const got: unknown[] = [];
    const off = m.sdk.on('config', (c: unknown) => got.push(c));
    win.__miniappEvent('config', JSON.stringify({ sources: [1] }));
    off();
    win.__miniappEvent('config', JSON.stringify({ sources: [2] }));
    expect(got).toEqual([{ sources: [1] }]);
  });
  test('sự kiện lạ vẫn bị từ chối', () => {
    expect(() => env().m.sdk.on('nope', () => undefined)).toThrow();
  });
});
