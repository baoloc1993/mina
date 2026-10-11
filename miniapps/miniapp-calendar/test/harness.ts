// Giàn test: chạy mã Lịch trên BRIDGE THẬT của shell (scope guard + SQL guard + xoá mềm) + host của mock SDK + node:sqlite.
// Chỉ dùng trong test — mã app (src/) không import gì của shell. Mỗi `machine()` là một "máy" với DB riêng và thông báo giả
// (đồng hồ giả điều khiển được); `push(a, b)` mô phỏng đồng bộ một chiều.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BridgeError, handleRpc, type BridgeContext, type IntentOutcome, type Manifest } from '../../../mobile/src/bridge/bridge';
import { inferTablePrefix, prepareDatabase } from '../../../mobile/packages/miniapp-sdk/mock/src/db';
import { createMockHost, type NetMode, type IntentMessage } from '../../../mobile/packages/miniapp-sdk/mock/src/host';
import { openNodeDb } from '../../../mobile/packages/miniapp-sdk/test/nodeDriver';
import type { Sdk } from '../src/sdk';

const PUBLIC = join(__dirname, '../public');
export const manifest: Manifest = JSON.parse(readFileSync(join(PUBLIC, 'manifest.json'), 'utf8'));
const migrations = readdirSync(join(PUBLIC, 'migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((name) => ({ name, sql: readFileSync(join(PUBLIC, 'migrations', name), 'utf8') }));
export const PREFIX = inferTablePrefix(manifest, migrations);

const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
/** Manifest Ghi chú giả: đủ để bridge kiểm `note.open` (nhận) như shell thật. */
export const noteManifest: Manifest = {
  id: 'vn.app.note',
  name: 'Ghi chú',
  version: '0.2.0',
  sdk: '^0.1.1',
  entry: 'index.html',
  scopes: ['db.own'],
  tables: ['notes'],
  intents: { sends: [], receives: [{ type: 'note.open', version: '1', schema: { type: 'object', required: ['noteId'], properties: { noteId: { type: 'string', pattern: UUID } }, additionalProperties: false } }] },
} as unknown as Manifest;

export interface FiredNote {
  id: string;
  at: number;
  title: string;
  body: string;
  ref: string | null;
}

export interface Machine {
  sdk: Sdk;
  db: ReturnType<typeof openNodeDb>;
  rpc(method: string, params?: Record<string, unknown>): Promise<unknown>;
  setNet(m: NetMode): void;
  /** Thông báo hệ thống giả (id → nội dung) + đồng hồ giả. */
  notes: Map<string, FiredNote>;
  fired: FiredNote[];
  clock: { now: number };
  /** Tới giờ: các thông báo `at ≤ now` được "kêu" (chuyển sang `fired`, và để lại dòng như shell thật giữ ≤ 1 ngày). */
  advance(ms: number): FiredNote[];
  /** Từ chối quyền thông báo. */
  denyNotifications(b: boolean): void;
  /** Ghi Ghi chú có cài không (note.open → handled) hay chưa (INTENT_NO_HANDLER). */
  noteInstalled: boolean;
  intents: IntentMessage[];
  close(): void;
}

export function machine(startMs = Date.parse('2026-10-09T01:00:00Z')): Machine {
  const db = openNodeDb();
  prepareDatabase(db, manifest, PREFIX, migrations);
  let net: NetMode = 'online';
  const clock = { now: startMs };
  const notes = new Map<string, FiredNote>();
  const fired: FiredNote[] = [];
  const intents: IntentMessage[] = [];
  let denied = false;
  const m = { noteInstalled: true };
  const mock = createMockHost({
    manifest: () => manifest,
    driver: db,
    hopFetch: async () => ({ status: 200, headers: {}, body: '' }),
    bus: {
      peers: () => (m.noteInstalled ? [manifest, noteManifest] : [manifest]),
      deliver: async (msg): Promise<IntentOutcome> => {
        intents.push(msg);
        return 'opened';
      },
    },
    netMode: () => net,
    clock: () => clock.now,
  });
  // Thông báo: thay phần notify của mock bằng bản kiểm soát được (shell thật: quyền, giữ dòng đã kêu, tối đa 50 sắp tới gần nhất).
  const host = mock.host;
  host.notify = {
    schedule: async (n) => {
      if (denied) throw new BridgeError('PERMISSION_DENIED', 'Người dùng chưa cho phép thông báo');
      notes.set(n.id, { id: n.id, at: n.at, title: n.title, body: n.body, ref: n.ref });
      const upcoming = [...notes.values()].filter((x) => x.at > clock.now).sort((a, b) => a.at - b.at);
      for (const extra of upcoming.slice(50)) notes.delete(extra.id);
    },
    cancel: async (id) => void notes.delete(id),
    list: async () => [...notes.values()].sort((a, b) => a.at - b.at),
  };
  const ctx: BridgeContext = { manifest, tablePrefix: PREFIX, host };
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
    notify: {
      schedule: (n: { id: string; at: number; title: string; body?: string; ref?: unknown }) => rpc('notify.schedule', { id: n.id, at: n.at, title: n.title, body: n.body, ref: n.ref }),
      cancel: (nid: string) => rpc('notify.cancel', { id: nid }),
      list: () => rpc('notify.list'),
    },
    intent: { send: (type: string, payload: unknown, o?: { mode?: string }) => rpc('intent.send', { type, payload, mode: o?.mode ?? 'create' }) },
    ui: { toast: (text: string) => rpc('ui.toast', { text }) },
    sdk: { info: () => rpc('sdk.info') },
  } as unknown as Sdk;
  return {
    sdk,
    db,
    rpc,
    setNet: (n) => void (net = n),
    notes,
    fired,
    clock,
    advance(ms) {
      clock.now += ms;
      const out: FiredNote[] = [];
      for (const n of notes.values()) {
        if (n.at <= clock.now && !fired.some((f) => f.id === n.id && f.at === n.at)) {
          fired.push(n);
          out.push(n);
        }
      }
      return out;
    },
    denyNotifications: (b) => void (denied = b),
    get noteInstalled() {
      return m.noteInstalled;
    },
    set noteInstalled(v) {
      m.noteInstalled = v;
    },
    intents,
    close: () => undefined,
  };
}

const T = (name: string) => `${PREFIX}_${name}`;
type Row = Record<string, unknown>;

/** Đồng bộ một chiều a → b: dòng mới chèn, xoá mềm thắng, bảng LWW lấy bản của bên gửi. */
export function push(a: Machine, b: Machine, tables = ['events', 'event_overrides'], lww = ['events']): void {
  for (const t of tables) {
    const phys = T(t);
    for (const r of a.db.all(`SELECT * FROM ${phys}`, []) as Row[]) {
      const have = (b.db.all(`SELECT * FROM ${phys} WHERE id = ?`, [r.id]) as Row[])[0];
      if (!have) {
        const cols = Object.keys(r);
        b.db.run(`INSERT INTO ${phys} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => r[c]));
      } else if (r.deleted_at && !have.deleted_at) {
        b.db.run(`UPDATE ${phys} SET deleted_at = ? WHERE id = ?`, [r.deleted_at, r.id]);
      } else if (lww.includes(t) && !have.deleted_at) {
        const cols = Object.keys(r).filter((c) => !['id', 'tenant_id', 'created_at', 'deleted_at'].includes(c));
        b.db.run(`UPDATE ${phys} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [...cols.map((c) => r[c]), r.id]);
      }
    }
  }
}
export const sync2 = (a: Machine, b: Machine) => (push(a, b), push(b, a));
