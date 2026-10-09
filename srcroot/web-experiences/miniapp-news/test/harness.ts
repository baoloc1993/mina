// Giàn test: chạy mã Đọc báo trên BRIDGE THẬT của shell (scope guard + SQL guard + xoá mềm + whitelist mạng) + host của mock SDK +
// node:sqlite. Chỉ dùng trong test. Mỗi `machine()` là một "máy" với DB riêng, "máy chủ web" giả (feed theo URL) và hộp thoại quyền
// host trả lời được; `sync2(a, b)` mô phỏng đồng bộ hai chiều.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { handleRpc, type BridgeContext, type IntentOutcome, type Manifest } from '../../../mobile-experiences/shell/src/bridge/bridge';
import { inferTablePrefix, prepareDatabase } from '../../../mobile-experiences/shell/packages/miniapp-sdk/mock/src/db';
import { createMockHost, type NetMode, type IntentMessage } from '../../../mobile-experiences/shell/packages/miniapp-sdk/mock/src/host';
import { openNodeDb } from '../../../mobile-experiences/shell/packages/miniapp-sdk/test/nodeDriver';
import type { Sdk } from '../src/sdk';

const PUBLIC = join(__dirname, '../public');
export const manifest: Manifest = JSON.parse(readFileSync(join(PUBLIC, 'manifest.json'), 'utf8'));
const migrations = readdirSync(join(PUBLIC, 'migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((name) => ({ name, sql: readFileSync(join(PUBLIC, 'migrations', name), 'utf8') }));
export const PREFIX = inferTablePrefix(manifest, migrations);
export const feedFile = (name: string) => readFileSync(join(__dirname, 'feeds', name), 'utf8');

const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
/** Manifest Ghi chú / Lịch giả: đủ để bridge kiểm `note.create` / `calendar.reminder.create` như shell thật (schema giống hợp đồng). */
export const noteManifest: Manifest = {
  id: 'vn.app.note', name: 'Ghi chú', version: '0.2.1', sdk: '^0.1.1', entry: 'index.html', scopes: ['db.own'], tables: ['notes'],
  intents: {
    sends: [],
    receives: [
      {
        type: 'note.create', version: '1',
        schema: {
          type: 'object', required: ['title'],
          properties: {
            id: { type: 'string', pattern: UUID }, title: { type: 'string', minLength: 1, maxLength: 200 },
            body: { type: 'string', maxLength: 20000 }, url: { type: 'string', maxLength: 2048, pattern: '^https?://' },
          },
          additionalProperties: false,
        },
      },
      { type: 'note.open', version: '1', schema: { type: 'object', required: ['noteId'], properties: { noteId: { type: 'string', pattern: UUID } }, additionalProperties: false } },
    ],
  },
} as unknown as Manifest;
export const calendarManifest: Manifest = {
  id: 'vn.app.calendar', name: 'Lịch', version: '0.1.5', sdk: '^0.1.1', entry: 'index.html', scopes: ['db.own'], tables: ['events'],
  intents: {
    sends: [],
    receives: [
      {
        type: 'calendar.reminder.create', version: '1',
        schema: {
          type: 'object', required: ['id', 'title', 'at'],
          properties: {
            id: { type: 'string', pattern: UUID }, title: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' },
            at: { oneOf: [{ type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$' }, { type: 'number', minimum: 946684800000, maximum: 4102444800000 }] },
            ref: { type: 'object', required: ['app', 'id'], properties: { app: { type: 'string', maxLength: 64 }, id: { type: 'string', maxLength: 64 } }, additionalProperties: false },
          },
          additionalProperties: false,
        },
      },
    ],
  },
} as unknown as Manifest;

/** Một phản hồi của "máy chủ web" giả. */
export type Page = { status?: number; body?: string; headers?: Record<string, string> };

export interface Machine {
  sdk: Sdk;
  db: ReturnType<typeof openNodeDb>;
  rpc(method: string, params?: Record<string, unknown>): Promise<unknown>;
  setNet(m: NetMode): void;
  clock: { now: number };
  /** Trang web giả theo URL đầy đủ; không có → 404. Hàm thì gọi mỗi lần tải. */
  web: Map<string, Page | (() => Page)>;
  /** URL đã THẬT SỰ rời máy (qua hopFetch). */
  hops: string[];
  /** Trả lời hộp thoại quyền host: true/false cố định hoặc hàm. */
  answer: { value: boolean | ((host: string) => boolean) };
  asked: { host: string; reason: string | null }[];
  opened: string[];
  intents: IntentMessage[];
  installed: { note: boolean; calendar: boolean };
  config: { value: Record<string, unknown> };
  foreground: { value: boolean };
  close(): void;
}

export function machine(startMs = Date.parse('2026-10-09T05:00:00Z')): Machine {
  const db = openNodeDb();
  prepareDatabase(db, manifest, PREFIX, migrations);
  let net: NetMode = 'online';
  const clock = { now: startMs };
  const web = new Map<string, Page | (() => Page)>();
  const hops: string[] = [];
  const asked: { host: string; reason: string | null }[] = [];
  const opened: string[] = [];
  const intents: IntentMessage[] = [];
  const answer: { value: boolean | ((host: string) => boolean) } = { value: true };
  const installed = { note: true, calendar: true };
  const config: { value: Record<string, unknown> } = { value: {} };
  const foreground = { value: true };
  const mock = createMockHost({
    manifest: () => manifest,
    driver: db,
    config: () => config.value,
    foreground: () => foreground.value,
    hopFetch: async (r) => {
      hops.push(r.url);
      const p = web.get(r.url);
      const page = typeof p === 'function' ? p() : p;
      if (!page) return { status: 404, headers: {}, body: '<html>Not found</html>' };
      return { status: page.status ?? 200, headers: page.headers ?? {}, body: page.body ?? '' };
    },
    bus: {
      peers: () => [manifest, ...(installed.note ? [noteManifest] : []), ...(installed.calendar ? [calendarManifest] : [])],
      deliver: async (msg): Promise<IntentOutcome> => {
        intents.push(msg);
        return msg.mode === 'open' ? 'opened' : 'handled';
      },
    },
    netMode: () => net,
    clock: () => clock.now,
    callbacks: {
      confirmAccess: async (host, reason) => {
        asked.push({ host, reason });
        return typeof answer.value === 'function' ? answer.value(host) : answer.value;
      },
      openUrl: (u) => void opened.push(u),
    },
  });
  const ctx: BridgeContext = { manifest, tablePrefix: PREFIX, host: mock.host };
  let id = 0;
  const rpc = async (method: string, params: Record<string, unknown> = {}) => {
    const r = await handleRpc({ jsonrpc: '2.0', id: ++id, method, params }, ctx);
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code, detail: r.error.detail });
    return r.result;
  };
  const sdk = {
    db: {
      query: (sql: string, params: unknown[] = [], opts?: { includeDeleted?: boolean }) => rpc('db.query', { sql, params, includeDeleted: !!opts?.includeDeleted }),
      execute: (sql: string, params: unknown[] = []) => rpc('db.execute', { sql, params }),
      transaction: (statements: { sql: string; params?: unknown[] }[]) => rpc('db.transaction', { statements: statements.map((s) => ({ sql: s.sql, params: s.params ?? [] })) }),
    },
    net: {
      fetch: (url: string, o: { timeoutMs?: number; headers?: Record<string, string> } = {}) => rpc('net.fetch', { url, timeoutMs: o.timeoutMs, headers: o.headers }),
      requestAccess: (r: { host: string; reason?: string }) => rpc('net.requestAccess', r),
    },
    intent: { send: (type: string, payload: unknown, o?: { mode?: string }) => rpc('intent.send', { type, payload, mode: o?.mode ?? 'create' }) },
    ui: { toast: (text: string) => rpc('ui.toast', { text }), openUrl: (url: string) => rpc('ui.openUrl', { url }) },
    sdk: { info: () => rpc('sdk.info'), ready: () => rpc('sdk.ready'), on: () => () => undefined },
    sync: { status: () => rpc('sync.status') },
  } as unknown as Sdk;
  return { sdk, db, rpc, setNet: (n) => void (net = n), clock, web, hops, answer, asked, opened, intents, installed, config, foreground, close: () => undefined };
}

const T = (name: string) => `${PREFIX}_${name}`;
type Row = Record<string, unknown>;

/** Đồng bộ một chiều a → b: dòng mới chèn, xoá mềm thắng, cột khác LWW theo bên gửi (thứ tự gọi = thứ tự tới server). */
export function push(a: Machine, b: Machine, tables = ['sources', 'items']): void {
  for (const t of tables) {
    const phys = T(t);
    for (const r of a.db.all(`SELECT * FROM ${phys}`, []) as Row[]) {
      const have = (b.db.all(`SELECT * FROM ${phys} WHERE id = ?`, [r.id]) as Row[])[0];
      if (!have) {
        const cols = Object.keys(r);
        b.db.run(`INSERT INTO ${phys} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => r[c]));
      } else if (r.deleted_at && !have.deleted_at) {
        b.db.run(`UPDATE ${phys} SET deleted_at = ? WHERE id = ?`, [r.deleted_at, r.id]);
      } else if (!have.deleted_at) {
        const cols = Object.keys(r).filter((c) => !['id', 'tenant_id', 'created_at', 'deleted_at'].includes(c));
        b.db.run(`UPDATE ${phys} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [...cols.map((c) => r[c]), r.id]);
      }
    }
  }
}
export const sync2 = (a: Machine, b: Machine) => (push(a, b), push(b, a));
