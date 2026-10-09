// Bảng kỳ vọng DÙNG CHUNG (AC-9, AC-15): Jest của shell và Vitest của mock SDK cùng import file này, cùng chạy
// `handleRpc` thật với Host giả có bộ đếm lời gọi. Quy tắc bất biến:
//   thiếu scope  → SCOPE_DENIED + 0 lời gọi Host
//   chỉ đọc      → READ_ONLY (method ghi) + 0 lời gọi Host
//   có scope     → chạy (có ít nhất lời gọi Host tương ứng)
import { handleRpc, SDK_VERSION } from './bridge';
import type { BridgeContext, Host, Manifest, RpcResponse, Stmt } from './types';

export type Calls = Record<string, number>;

export interface FakeHost {
  host: Host;
  calls: Calls;
  total(): number;
  setReadOnly(v: boolean): void;
}

export const RECEIVER_SCHEMA = {
  type: 'object',
  required: ['title', 'at'],
  properties: { title: { type: 'string', minLength: 1 }, at: { type: 'number' } },
  additionalProperties: false,
};

export function makeFakeHost(opts: { readOnly?: boolean } = {}): FakeHost {
  const calls: Calls = {};
  let readOnly = !!opts.readOnly;
  const hit = (k: string) => {
    calls[k] = (calls[k] ?? 0) + 1;
  };
  const host: Host = {
    now: () => '2026-10-09T00:00:00.000Z',
    newId: () => '00000000-0000-4000-8000-000000000001',
    tenantId: () => 'T1',
    isReadOnly: () => readOnly,
    sdkInfo: () => ({ sdkVersion: SDK_VERSION, platform: 'test' }),
    db: {
      all: async () => (hit('db.all'), []),
      run: async () => void hit('db.run'),
      transaction: async (_s: Stmt[]) => void hit('db.transaction'),
    },
    sync: { status: () => (hit('sync.status'), { state: 'online', pending: 0, rejected: 0, lastSyncedAt: null }) },
    auth: { appToken: async () => (hit('auth.appToken'), { token: 't', expires_at: 1 }) },
    lifecycle: { ready: () => hit('lifecycle.ready'), suspended: () => hit('lifecycle.suspended') },
    notify: {
      schedule: async () => void hit('notify.schedule'),
      cancel: async () => void hit('notify.cancel'),
      list: async () => (hit('notify.list'), []),
    },
    storage: {
      put: async () => (hit('storage.put'), { fileId: 'f1', uri: 'file:///f1', status: 'local' as const }),
      get: async () => (hit('storage.get'), { fileId: 'f1', uri: 'file:///f1', status: 'local' as const }),
      remove: async () => void hit('storage.remove'),
    },
    net: {
      fetch: async (_r, isAllowed) => {
        hit('net.fetch');
        isAllowed('https://example.com/');
        return { status: 200, headers: {}, body: 'ok' };
      },
    },
    ui: {
      toast: () => hit('ui.toast'),
      pickImage: async () => (hit('ui.pickImage'), { files: [] }),
      pickFile: async () => (hit('ui.pickFile'), { files: [] }),
      share: async () => void hit('ui.share'),
    },
    intent: {
      receivers: (type, version) => {
        hit('intent.receivers');
        return type === 'cal.reminder.create' && (version === null || version === '1')
          ? [{ appId: 'vn.app.hello-cal', type, version: '1', schema: RECEIVER_SCHEMA }]
          : [];
      },
      deliver: async () => (hit('intent.deliver'), 'handled' as const),
    },
  };
  return {
    host,
    calls,
    total: () => Object.values(calls).reduce((a, b) => a + b, 0),
    setReadOnly: (v) => {
      readOnly = v;
    },
  };
}

export function manifestWith(scopes: string[]): Manifest {
  return {
    id: 'vn.app.hello',
    name: 'Hello',
    version: '0.2.0',
    sdk: '^0.1',
    entry: 'index.html',
    scopes,
    tables: ['items'],
    intents: { sends: [{ type: 'cal.reminder.create', version: '1' }], receives: [] },
    network: ['example.com'],
  };
}

export interface MatrixCase {
  namespace: 'sdk' | 'db' | 'core' | 'intent' | 'notify' | 'storage' | 'net' | 'ui' | 'sync' | 'auth';
  method: string;
  params: Record<string, unknown>;
  /** Scope cần để chạy được; [] = luôn được phép. */
  grants: string[];
  /** Method ghi → READ_ONLY khi chỉ đọc. */
  writes: boolean;
  /** Lời gọi Host phải xuất hiện khi chạy thành công. */
  effect: string;
}

export const CASES: MatrixCase[] = [
  { namespace: 'sdk', method: 'sdk.ready', params: {}, grants: [], writes: false, effect: 'lifecycle.ready' },
  { namespace: 'sdk', method: 'sdk.info', params: {}, grants: [], writes: false, effect: '' },
  { namespace: 'db', method: 'db.query', params: { sql: 'SELECT * FROM items', params: [] }, grants: ['db.own'], writes: false, effect: 'db.all' },
  { namespace: 'db', method: 'db.execute', params: { sql: 'INSERT INTO items (id, title) VALUES (?, ?)', params: ['i1', 'a'] }, grants: ['db.own'], writes: true, effect: 'db.run' },
  {
    namespace: 'db', method: 'db.transaction',
    params: { statements: [{ sql: 'INSERT INTO items (id, title) VALUES (?, ?)', params: ['i1', 'a'] }, { sql: 'DELETE FROM items WHERE id = ?', params: ['i1'] }] },
    grants: ['db.own'], writes: true, effect: 'db.transaction',
  },
  { namespace: 'core', method: 'core.tags.list', params: {}, grants: ['core.tags:read'], writes: false, effect: 'db.all' },
  { namespace: 'core', method: 'core.tags.create', params: { name: 'việc nhà' }, grants: ['core.tags:write'], writes: true, effect: 'db.run' },
  { namespace: 'core', method: 'core.contacts.search', params: { q: 'an' }, grants: ['core.contacts:read'], writes: false, effect: 'db.all' },
  { namespace: 'core', method: 'core.contacts.create', params: { name: 'An' }, grants: ['core.contacts:write'], writes: true, effect: 'db.run' },
  { namespace: 'core', method: 'core.files.list', params: {}, grants: ['core.files:read'], writes: false, effect: 'db.all' },
  { namespace: 'intent', method: 'intent.send', params: { type: 'cal.reminder.create', payload: { title: 'x', at: 1 }, mode: 'create' }, grants: ['intent.send'], writes: true, effect: 'intent.deliver' },
  { namespace: 'notify', method: 'notify.schedule', params: { id: 'n1', at: 1_800_000_000_000, title: 'Nhắc', body: '' }, grants: ['notify.local'], writes: false, effect: 'notify.schedule' },
  { namespace: 'notify', method: 'notify.cancel', params: { id: 'n1' }, grants: ['notify.local'], writes: false, effect: 'notify.cancel' },
  { namespace: 'notify', method: 'notify.list', params: {}, grants: ['notify.local'], writes: false, effect: 'notify.list' },
  { namespace: 'storage', method: 'storage.put', params: { name: 'a.txt', mime: 'text/plain', base64: 'aGk=' }, grants: ['storage.files'], writes: true, effect: 'storage.put' },
  { namespace: 'storage', method: 'storage.get', params: { fileId: 'f1' }, grants: ['storage.files'], writes: false, effect: 'storage.get' },
  { namespace: 'storage', method: 'storage.remove', params: { fileId: 'f1' }, grants: ['storage.files'], writes: true, effect: 'storage.remove' },
  { namespace: 'net', method: 'net.fetch', params: { url: 'https://example.com/a' }, grants: ['net'], writes: false, effect: 'net.fetch' },
  { namespace: 'ui', method: 'ui.toast', params: { text: 'xin chào' }, grants: ['ui.native'], writes: false, effect: 'ui.toast' },
  { namespace: 'ui', method: 'ui.pickImage', params: {}, grants: ['ui.native', 'storage.files'], writes: true, effect: 'ui.pickImage' },
  { namespace: 'ui', method: 'ui.pickFile', params: { mime: ['application/pdf'] }, grants: ['ui.native', 'storage.files'], writes: true, effect: 'ui.pickFile' },
  { namespace: 'ui', method: 'ui.share', params: { text: 'a' }, grants: ['ui.native'], writes: false, effect: 'ui.share' },
  { namespace: 'sync', method: 'sync.status', params: {}, grants: [], writes: false, effect: 'sync.status' },
  { namespace: 'auth', method: 'auth.getAppToken', params: {}, grants: ['auth.token'], writes: false, effect: 'auth.appToken' },
];

export interface CaseRun {
  resp: RpcResponse;
  calls: Calls;
  total: number;
}

/** Chạy một ca với manifest chỉ có `scopes`, Host giả mới tinh. */
export async function runCase(c: MatrixCase, scopes: string[], opts: { readOnly?: boolean } = {}): Promise<CaseRun> {
  const fake = makeFakeHost(opts);
  const ctx: BridgeContext = { manifest: manifestWith(scopes), tablePrefix: 'app_hello', host: fake.host };
  const resp = await handleRpc({ jsonrpc: '2.0', id: 1, method: c.method, params: c.params }, ctx);
  return { resp, calls: fake.calls, total: fake.total() };
}

/**
 * Kết quả mong đợi của cả bảng — một chuỗi dễ so sánh giữa shell và mock:
 * "<method>|<không scope>|<có scope>|<chỉ đọc>" với mỗi ô là mã lỗi hoặc OK.
 */
export async function summarizeMatrix(): Promise<string[]> {
  const out: string[] = [];
  for (const c of CASES) {
    const none = await runCase(c, []);
    const ok = await runCase(c, c.grants);
    const ro = await runCase(c, c.grants, { readOnly: true });
    const cell = (r: CaseRun) => r.resp.error?.code ?? 'OK';
    out.push(`${c.method}|${cell(none)}|${cell(ok)}|${cell(ro)}`);
  }
  return out;
}
