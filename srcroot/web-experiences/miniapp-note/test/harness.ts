// Giàn test: chạy mã Ghi chú trên BRIDGE THẬT của shell (scope guard + SQL guard + xoá mềm) + host của mock SDK + node:sqlite.
// Chỉ dùng trong test — mã app (src/) không import gì của shell. Mỗi `machine()` là một "máy" với DB riêng; `push(a, b)` mô phỏng
// đồng bộ một chiều (đúng ngữ nghĩa upload: dòng mới được chèn, xoá mềm thắng, cột note/tag lấy bản của bên gửi — "bản tới sau thắng").
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as Y from 'yjs';
import { handleRpc, type BridgeContext, type Manifest } from '../../../mobile-experiences/shell/src/bridge/bridge';
import { createTabBus, type TabBus } from '../../../mobile-experiences/shell/packages/miniapp-sdk/mock/src/bus';
import { inferTablePrefix, prepareDatabase } from '../../../mobile-experiences/shell/packages/miniapp-sdk/mock/src/db';
import { createMockHost, type IntentMessage, type NetMode } from '../../../mobile-experiences/shell/packages/miniapp-sdk/mock/src/host';
import { openNodeDb } from '../../../mobile-experiences/shell/packages/miniapp-sdk/test/nodeDriver';
import { FRAGMENT } from '../src/crdt/doc';
import type { Sdk } from '../src/sdk';

const PUBLIC = join(__dirname, '../public');
export const manifest: Manifest = JSON.parse(readFileSync(join(PUBLIC, 'manifest.json'), 'utf8'));
const migrations = readdirSync(join(PUBLIC, 'migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((name) => ({ name, sql: readFileSync(join(PUBLIC, 'migrations', name), 'utf8') }));
export const PREFIX = inferTablePrefix(manifest, migrations);

const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
/** Manifest Lịch giả (schema nhận theo ARCHITECTURE §5 `intent-calendar`) — Lịch thật chưa nằm trong repo test này. */
export const calendarManifest: Manifest = {
  id: 'vn.app.calendar',
  name: 'Lịch',
  version: '0.1.0',
  sdk: '^0.1.1',
  entry: 'index.html',
  scopes: ['db.own'],
  tables: ['events'],
  intents: {
    sends: [{ type: 'note.open', version: '1' }],
    receives: [
      {
        type: 'calendar.reminder.create',
        version: '1',
        schema: {
          type: 'object',
          required: ['id', 'title', 'at'],
          properties: {
            id: { type: 'string', pattern: UUID },
            title: { type: 'string', minLength: 1, maxLength: 200 },
            at: { oneOf: [{ type: 'string', pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$' }, { type: 'number' }] },
            ref: { type: 'object', required: ['app', 'id'], properties: { app: { type: 'string', maxLength: 64 }, id: { type: 'string', maxLength: 64 } }, additionalProperties: false },
          },
          additionalProperties: false,
        },
      },
      {
        type: 'calendar.event.open',
        version: '1',
        schema: { type: 'object', required: ['eventId'], properties: { eventId: { type: 'string', pattern: UUID } }, additionalProperties: false },
      },
    ],
  },
} as Manifest;

/** Điều khiển Lịch giả: cài/chưa cài, kết quả giao, và các intent đã giao (qua kiểm schema của bridge thật). */
export interface FakeCalendar {
  installed: boolean;
  outcome: 'handled' | 'queued' | 'opened';
  delivered: IntentMessage[];
}

type Picked = { name: string; mime: string; base64: string }[];
export interface Machine {
  sdk: Sdk;
  db: ReturnType<typeof openNodeDb>;
  rpc(method: string, params?: Record<string, unknown>): Promise<unknown>;
  setNet(m: NetMode): void;
  calendar: FakeCalendar;
  /** Hàng đợi cho hộp chọn ảnh / tệp ở lần gọi kế tiếp. */
  pickImage: Picked;
  pickFile: Picked;
  close(): void;
}

const buses: TabBus[] = [];
export function closeAll() {
  while (buses.length) buses.pop()!.close();
}

let seq = 0;
export function machine(): Machine {
  const db = openNodeDb();
  prepareDatabase(db, manifest, PREFIX, migrations);
  let net: NetMode = 'online';
  const m = { pickImage: [] as Picked, pickFile: [] as Picked };
  const bus = createTabBus(() => manifest, `note-test-${Date.now()}-${seq++}`);
  buses.push(bus);
  const calendar: FakeCalendar = { installed: true, outcome: 'handled', delivered: [] };
  const fakeBus = {
    peers: () => [...bus.peers(), ...(calendar.installed ? [calendarManifest] : [])],
    deliver: async (msg: IntentMessage) => (calendar.delivered.push(msg), calendar.outcome),
  };
  const mock = createMockHost({
    manifest: () => manifest,
    driver: db,
    hopFetch: async () => ({ status: 200, headers: {}, body: '' }),
    bus: fakeBus,
    netMode: () => net,
    callbacks: { pickImage: async () => m.pickImage.splice(0), pickFile: async () => m.pickFile.splice(0) },
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
    core: { tags: { list: () => rpc('core.tags.list'), create: (t: { name: string; color?: string }) => rpc('core.tags.create', t) } },
    storage: { get: (fileId: string) => rpc('storage.get', { fileId }) },
    ui: {
      pickImage: (o?: { multiple?: boolean }) => rpc('ui.pickImage', { multiple: !!o?.multiple }),
      pickFile: (o?: { mime?: string[]; multiple?: boolean }) => rpc('ui.pickFile', { mime: o?.mime, multiple: !!o?.multiple }),
      toast: (text: string) => rpc('ui.toast', { text }),
    },
    sdk: { info: () => rpc('sdk.info') },
    intent: { send: (type: string, payload: unknown, o?: { mode?: string; version?: string }) => rpc('intent.send', { type, payload, mode: o?.mode, version: o?.version }) },
  } as unknown as Sdk;
  return { sdk, db, rpc, calendar, setNet: (n) => void (net = n), pickImage: m.pickImage, pickFile: m.pickFile, close: () => bus.close() };
}

const T = (name: string) => `${PREFIX}_${name}`;
type Row = Record<string, unknown>;

/** Đồng bộ một chiều a → b. `lww` = bảng lấy bản của bên gửi khi hai bên cùng có dòng (bản tới sau thắng). */
export function push(a: Machine, b: Machine, tables = ['notes', 'note_blocks', 'note_tags', 'note_files', 'note_reminders'], lww = ['notes']): void {
  const sync = (phys: string, isLww: boolean) => {
    const src = a.db.all(`SELECT * FROM ${phys}`, []) as Row[];
    for (const r of src) {
      const have = (b.db.all(`SELECT * FROM ${phys} WHERE id = ?`, [r.id]) as Row[])[0];
      if (!have) {
        const cols = Object.keys(r);
        b.db.run(`INSERT INTO ${phys} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => r[c]));
        continue;
      }
      if (r.deleted_at && !have.deleted_at) b.db.run(`UPDATE ${phys} SET deleted_at = ? WHERE id = ?`, [r.deleted_at, r.id]);
      else if (isLww && !have.deleted_at) {
        const cols = Object.keys(r).filter((c) => !['id', 'tenant_id', 'created_at', 'deleted_at'].includes(c));
        b.db.run(`UPDATE ${phys} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [...cols.map((c) => r[c]), r.id]);
      }
    }
  };
  for (const t of tables) sync(T(t), lww.includes(t));
  // core_* dùng chung (tag, file) — chèn nếu thiếu
  for (const phys of ['core_tags', 'core_files']) {
    const src = a.db.all(`SELECT * FROM ${phys}`, []) as Row[];
    for (const r of src) {
      if ((b.db.all(`SELECT id FROM ${phys} WHERE id = ?`, [r.id]) as Row[]).length) continue;
      const cols = Object.keys(r);
      b.db.run(`INSERT INTO ${phys} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => r[c]));
    }
  }
}

export const sync2 = (a: Machine, b: Machine) => (push(a, b), push(b, a));

/** Gõ một đoạn văn vào tài liệu như người dùng (origin cục bộ). */
export function typeParagraph(doc: Y.Doc, text: string, origin: unknown = 'local'): void {
  doc.transact(() => {
    const frag = doc.getXmlFragment(FRAGMENT);
    const p = new Y.XmlElement('paragraph');
    frag.push([p]);
    const t = new Y.XmlText();
    p.push([t]);
    t.insert(0, text);
  }, origin);
}

export const blockRows = (m: Machine, noteId?: string) =>
  m.db.all(`SELECT id, note_id, kind, deleted_at FROM ${T('note_blocks')}${noteId ? ' WHERE note_id = ?' : ''} ORDER BY created_at, id`, noteId ? [noteId] : []) as { id: string; note_id: string; kind: string; deleted_at: string | null }[];
export const liveBlocks = (m: Machine, noteId?: string) => blockRows(m, noteId).filter((r) => !r.deleted_at);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
