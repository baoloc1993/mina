// @vitest-environment node
import { Window } from 'happy-dom';
import { describe, expect, test, vi } from 'vitest';
import { INJECTED_SDK } from '../src/injected';

type Sent = { jsonrpc: string; id: number; method: string; params: Record<string, unknown> };

/** Mỗi test một cửa sổ happy-dom riêng (window.miniapp không xoá được). */
function makeEnv() {
  const win: any = new Window({ url: 'https://app.test/' });
  const sent: Sent[] = [];
  win.__miniappTransport = (s: string) => sent.push(JSON.parse(s));
  win.eval(INJECTED_SDK);
  const reply = (id: number, result: unknown) => win.__miniappResolve(JSON.stringify({ jsonrpc: '2.0', id, result }));
  const err = (id: number, code: string, message: string, detail?: string) =>
    win.__miniappResolve({ jsonrpc: '2.0', id, error: { code, message, ...(detail ? { detail } : {}) } });
  return { win, sent, reply, err, m: win.miniapp };
}

const methods = (sent: Sent[], name: string) => sent.filter((s) => s.method === name);

describe('INJECTED_SDK', () => {
  test('window.miniapp bị đóng băng và không ghi đè được', () => {
    const { win, m } = makeEnv();
    expect(Object.isFrozen(m)).toBe(true);
    for (const ns of ['sdk', 'db', 'core', 'intent', 'notify', 'storage', 'net', 'ui', 'sync', 'auth']) {
      expect(Object.isFrozen(m[ns]), ns).toBe(true);
    }
    expect(Object.isFrozen(m.core.tags)).toBe(true);
    // gán lại bị bỏ qua (sloppy) hoặc ném (strict) — kết quả cuối phải như nhau
    try {
      win.miniapp = {};
    } catch {
      /* strict */
    }
    expect(win.miniapp).toBe(m);
    try {
      m.db = null;
    } catch {
      /* strict */
    }
    expect(typeof m.db.query).toBe('function');
    expect(() => Object.defineProperty(win, 'miniapp', { value: 1 })).toThrow();
  });

  test('idempotent: chèn lần hai không đổi gì', () => {
    const { win, m } = makeEnv();
    win.eval(INJECTED_SDK);
    expect(win.miniapp).toBe(m);
  });

  test('chỉ dùng cú pháp ES5 (WebView Android cũ)', () => {
    expect(INJECTED_SDK).not.toMatch(/=>|\bconst\b|\blet\b|`|\basync\b|\bawait\b/);
  });

  test('id tăng dần, gói JSON-RPC 2.0 đúng khung', async () => {
    const { sent, reply, m } = makeEnv();
    const a = m.sdk.ready();
    const b = m.sdk.info();
    expect(sent.map((s) => s.id)).toEqual([1, 2]);
    expect(sent[0]).toEqual({ jsonrpc: '2.0', id: 1, method: 'sdk.ready', params: {} });
    reply(2, { appId: 'x' });
    reply(1, true);
    await expect(a).resolves.toBe(true);
    await expect(b).resolves.toEqual({ appId: 'x' });
  });

  test('ánh xạ method + params đúng bảng', () => {
    const { sent, m } = makeEnv();
    const when = new Date('2026-10-10T01:00:00Z');
    const cases: [() => unknown, string, Record<string, unknown>][] = [
      [() => m.db.query('SELECT * FROM items WHERE id = ?', ['a']), 'db.query', { sql: 'SELECT * FROM items WHERE id = ?', params: ['a'], includeDeleted: false }],
      [() => m.db.query('SELECT 1', undefined, { includeDeleted: true }), 'db.query', { sql: 'SELECT 1', params: [], includeDeleted: true }],
      [() => m.db.execute('DELETE FROM items'), 'db.execute', { sql: 'DELETE FROM items', params: [] }],
      [() => m.db.transaction([{ sql: 'A' }, { sql: 'B', params: [1] }]), 'db.transaction', { statements: [{ sql: 'A', params: [] }, { sql: 'B', params: [1] }] }],
      [() => m.core.tags.list(), 'core.tags.list', {}],
      [() => m.core.tags.create({ name: 'việc nhà', color: '#112233' }), 'core.tags.create', { name: 'việc nhà', color: '#112233' }],
      [() => m.core.contacts.search('an'), 'core.contacts.search', { q: 'an' }],
      [() => m.core.contacts.create({ name: 'An', phone: '1' }), 'core.contacts.create', { name: 'An', phone: '1' }],
      [() => m.core.files.get('f1'), 'core.files.get', { id: 'f1' }],
      [() => m.core.files.list({ appId: 'vn.app.hello' }), 'core.files.list', { appId: 'vn.app.hello' }],
      [() => m.core.files.list(), 'core.files.list', {}],
      [() => m.intent.send('cal.reminder.create', { title: 't', at: 1 }), 'intent.send', { type: 'cal.reminder.create', payload: { title: 't', at: 1 }, mode: 'create' }],
      [() => m.intent.send('cal.event.open', {}, { mode: 'open', version: '1' }), 'intent.send', { type: 'cal.event.open', payload: {}, mode: 'open', version: '1' }],
      [() => m.notify.schedule({ id: 'n', at: when, title: 'T', ref: { a: 1 } }), 'notify.schedule', { id: 'n', at: when.getTime(), title: 'T', ref: '{"a":1}' }],
      [() => m.notify.schedule({ id: 'n', at: '2026-10-10T01:00:00Z', title: 'T', body: 'b', ref: 'r' }), 'notify.schedule', { id: 'n', at: when.getTime(), title: 'T', body: 'b', ref: 'r' }],
      [() => m.notify.schedule({ id: 'n', at: 5, title: 'T' }), 'notify.schedule', { id: 'n', at: 5, title: 'T' }],
      [() => m.notify.cancel('n'), 'notify.cancel', { id: 'n' }],
      [() => m.notify.list(), 'notify.list', {}],
      [() => m.storage.put({ name: 'a', mime: 'text/plain', base64: 'aGk=' }), 'storage.put', { name: 'a', mime: 'text/plain', base64: 'aGk=' }],
      [() => m.storage.get('f'), 'storage.get', { fileId: 'f' }],
      [() => m.storage.remove('f'), 'storage.remove', { fileId: 'f' }],
      [() => m.net.fetch('https://example.com/', { method: 'POST', headers: { a: 'b' }, body: 'x', timeoutMs: 100 }), 'net.fetch', { url: 'https://example.com/', method: 'POST', headers: { a: 'b' }, body: 'x', timeoutMs: 100 }],
      [() => m.ui.toast('hi'), 'ui.toast', { text: 'hi' }],
      [() => m.ui.pickImage(), 'ui.pickImage', { multiple: false }],
      [() => m.ui.pickImage({ multiple: true }), 'ui.pickImage', { multiple: true }],
      [() => m.ui.pickFile({ mime: ['application/pdf'] }), 'ui.pickFile', { mime: ['application/pdf'], multiple: false }],
      [() => m.ui.pickFile({ mime: ['image/*'], multiple: true }), 'ui.pickFile', { mime: ['image/*'], multiple: true }],
      [() => m.ui.share({ title: 'a', text: 'b', url: 'https://x.y' }), 'ui.share', { title: 'a', text: 'b', url: 'https://x.y' }],
      [() => m.sync.status(), 'sync.status', {}],
      [() => m.auth.getAppToken(), 'auth.getAppToken', {}],
      [() => m.call('fs.readFile', { path: '/' }), 'fs.readFile', { path: '/' }],
    ];
    for (const [fn, method, params] of cases) {
      sent.length = 0;
      void Promise.resolve(fn()).catch(() => undefined);
      expect(sent, method).toHaveLength(1);
      expect(sent[0].method).toBe(method);
      // JSON.stringify đã bỏ các khoá undefined
      expect(sent[0].params).toEqual(params);
    }
  });

  test('lỗi RPC → Error có .code và .detail', async () => {
    const { err, m } = makeEnv();
    const p = m.intent.send('x', {});
    err(1, 'INTENT_REJECTED', 'Payload không hợp lệ', '/title');
    const e = await p.then(
      () => null,
      (x: any) => x,
    );
    expect(Object.prototype.toString.call(e)).toBe('[object Error]');
    expect(e.code).toBe('INTENT_REJECTED');
    expect(e.detail).toBe('/title');
    expect(e.message).toBe('Payload không hợp lệ');
  });

  test('phản hồi lạ / id không có bị bỏ qua', () => {
    const { win } = makeEnv();
    expect(() => win.__miniappResolve('không phải json')).not.toThrow();
    expect(() => win.__miniappResolve({ id: 999, result: 1 })).not.toThrow();
  });

  test('thiếu cả hai đường nối → Promise bị từ chối INTERNAL', async () => {
    const { win, m } = makeEnv();
    win.__miniappTransport = undefined;
    const e = await m.sdk.ready().then(
      () => null,
      (x: any) => x,
    );
    expect(e.code).toBe('INTERNAL');
  });

  test('dùng ReactNativeWebView.postMessage khi không có __miniappTransport', () => {
    const { win, m } = makeEnv();
    const posts: string[] = [];
    win.__miniappTransport = undefined;
    win.ReactNativeWebView = { postMessage: (s: string) => posts.push(s) };
    void m.sdk.ready();
    expect(JSON.parse(posts[0]).method).toBe('sdk.ready');
  });

  describe('sự kiện', () => {
    test('on() từ chối sự kiện lạ, trả hàm huỷ', () => {
      const { win, m } = makeEnv();
      expect(() => m.sdk.on('boom', () => 1)).toThrow(/không hỗ trợ/);
      expect(() => m.sdk.on('sync', 1)).toThrow();
      const fn = vi.fn();
      const off = m.sdk.on('sync', fn);
      win.__miniappEvent('sync', JSON.stringify({ state: 'online' }));
      off();
      win.__miniappEvent('sync', { state: 'offline' });
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith({ state: 'online' });
    });

    test('handler ném lỗi không phá handler khác', () => {
      const { win, m } = makeEnv();
      const b = vi.fn();
      m.sdk.on('resume', () => {
        throw new Error('x');
      });
      m.sdk.on('resume', b);
      win.__miniappEvent('resume', null);
      expect(b).toHaveBeenCalled();
    });

    test('suspend: chạy mọi handler rồi mới gọi sdk.suspended', async () => {
      vi.useFakeTimers();
      try {
        const { win, sent, m } = makeEnv();
        win.setTimeout = setTimeout;
        win.clearTimeout = clearTimeout;
        const order: string[] = [];
        m.sdk.on('suspend', () => order.push('sync-handler'));
        m.sdk.on('suspend', () => new Promise<void>((r) => setTimeout(() => (order.push('slow-handler'), r()), 200)));
        win.__miniappEvent('suspend', null);
        await vi.advanceTimersByTimeAsync(100);
        expect(methods(sent, 'sdk.suspended')).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(150);
        expect(order).toEqual(['sync-handler', 'slow-handler']);
        expect(methods(sent, 'sdk.suspended')).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    test('suspend: handler chậm quá 450 ms bị bỏ qua, handler ném lỗi không chặn', async () => {
      vi.useFakeTimers();
      try {
        const { win, sent, m } = makeEnv();
        win.setTimeout = setTimeout;
        win.clearTimeout = clearTimeout;
        m.sdk.on('suspend', () => new Promise<void>(() => undefined)); // không bao giờ xong
        m.sdk.on('suspend', () => {
          throw new Error('hỏng');
        });
        m.sdk.on('suspend', () => Promise.reject(new Error('hỏng async')));
        win.__miniappEvent('suspend', null);
        await vi.advanceTimersByTimeAsync(400);
        expect(methods(sent, 'sdk.suspended')).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(100);
        expect(methods(sent, 'sdk.suspended')).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    test('suspend không có handler vẫn báo sdk.suspended; lifecycle.suspend là bí danh', async () => {
      const { win, sent } = makeEnv();
      win.__miniappEvent('lifecycle.suspend');
      await new Promise((r) => setTimeout(r, 10));
      expect(sent.map((s) => s.method)).toEqual(['sdk.suspended']);
    });

    test('intent tới trước khi đăng ký được giữ (tối đa 20) và giao khi đăng ký', async () => {
      const { win, m } = makeEnv();
      for (let i = 0; i < 25; i++) win.__miniappEvent('intent', JSON.stringify({ type: 't', payload: { i } }));
      const got: number[] = [];
      m.sdk.on('intent', (e: any) => got.push(e.payload.i));
      await new Promise((r) => setTimeout(r, 0));
      expect(got).toEqual(Array.from({ length: 20 }, (_, k) => k + 5)); // 5 cái cũ nhất bị bỏ
      win.__miniappEvent('intent', { type: 't', payload: { i: 99 } });
      expect(got.at(-1)).toBe(99);
    });
  });
});
