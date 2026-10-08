// Host của mock SDK: mọi hiệu ứng mà `handleRpc` (mã THẬT của shell) được phép gây ra.
// Không import DOM — chạy được cả ở Vitest (node) với driver node:sqlite và fetch giả.
import {
  BridgeError,
  SDK_VERSION,
  type Host,
  type IntentMode,
  type IntentOutcome,
  type Manifest,
  type ReceiverInfo,
  type StoredFile,
  type SyncStatus,
} from '../../../../src/bridge/bridge';
import { runTransaction, type SqlDriver } from './db';

export type NetMode = 'online' | 'offline' | 'ro';

/** Một bước HTTP (KHÔNG tự theo chuyển hướng). Ở trình duyệt đi qua /__mock/fetch của dev server. */
export type HopFetch = (req: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  timeoutMs: number;
}) => Promise<{ status: number; headers: Record<string, string>; body: string }>;

export interface IntentMessage {
  type: string;
  version: string;
  payload: unknown;
  mode: IntentMode;
  from: string;
  to: string;
}

/** Đường nối giữa các "tab" mock (BroadcastChannel ở trình duyệt). */
export interface IntentBus {
  /** Manifest các tab mock đã đăng ký (kể cả tab này). */
  peers(): Manifest[];
  deliver(msg: IntentMessage): Promise<IntentOutcome>;
}

export interface MockCallbacks {
  onReady?(): void;
  onSuspended?(): void;
  onToast?(text: string): void;
  onNotify?(n: { id: string; title: string; body: string; ref: string | null; at: number }, phase: 'scheduled' | 'fired' | 'cancelled'): void;
  /** Mở hộp chọn ảnh; trả danh sách file (rỗng = người dùng huỷ). */
  pickImage?(opts: { multiple: boolean }): Promise<{ name: string; mime: string; base64: string }[]>;
  share?(s: { title: string; text: string; url: string | null }): Promise<void>;
  onDbWrite?(): void;
}

export interface MockHostOptions {
  manifest: () => Manifest;
  driver: SqlDriver;
  hopFetch: HopFetch;
  bus: IntentBus;
  netMode: () => NetMode;
  callbacks?: MockCallbacks;
  clock?: () => number;
}

const MAX_HOPS = 5;
const b64Len = (b64: string) => Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);

export interface MockHost {
  host: Host;
  /** Số thay đổi ghi lúc offline (hiện ở sync.status.pending). */
  pending(): number;
  resetPending(): void;
}

export function createMockHost(o: MockHostOptions): MockHost {
  const clock = o.clock ?? (() => Date.now());
  const cb = o.callbacks ?? {};
  const files = new Map<string, StoredFile & { name: string; mime: string; base64: string }>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const scheduled = new Map<string, { id: string; at: number; title: string; body: string; ref: string | null }>();
  let pending = 0;
  let lastSyncedAt: string | null = new Date(clock()).toISOString();

  const noteWrite = () => {
    if (o.netMode() === 'offline') pending++;
    else lastSyncedAt = new Date(clock()).toISOString();
    cb.onDbWrite?.();
  };
  const newId = () => globalThis.crypto.randomUUID();
  const nowIso = () => new Date(clock()).toISOString();

  const host: Host = {
    now: nowIso,
    newId,
    tenantId: () => 'mock-tenant',
    isReadOnly: () => o.netMode() === 'ro',
    sdkInfo: () => ({ sdkVersion: SDK_VERSION, platform: 'mock-web' }),

    db: {
      all: async (sql, params) => o.driver.all(sql, params),
      run: async (sql, params) => {
        o.driver.run(sql, params);
        noteWrite();
      },
      transaction: async (stmts) => {
        runTransaction(o.driver, stmts);
        noteWrite();
      },
    },

    sync: {
      status: (): SyncStatus => {
        const mode = o.netMode();
        return {
          state: mode === 'offline' ? 'offline' : 'online',
          pending: mode === 'offline' ? pending : 0,
          rejected: 0,
          lastSyncedAt: mode === 'offline' ? lastSyncedAt : nowIso(),
        };
      },
    },

    auth: {
      appToken: async (appId) => ({ token: `mock.${appId}.token`, expires_at: Math.floor(clock() / 1000) + 900 }),
    },

    lifecycle: { ready: () => cb.onReady?.(), suspended: () => cb.onSuspended?.() },

    notify: {
      schedule: async (n) => {
        const prev = timers.get(n.id);
        if (prev) clearTimeout(prev);
        scheduled.set(n.id, n);
        cb.onNotify?.(n, 'scheduled');
        const fire = () => {
          timers.delete(n.id);
          scheduled.delete(n.id);
          cb.onNotify?.(n, 'fired');
        };
        // `at` trong quá khứ → kêu ngay (ARCHITECTURE §6 "Native"); setTimeout tối đa ~24 ngày
        const delay = Math.min(Math.max(0, n.at - clock()), 2_000_000_000);
        timers.set(n.id, setTimeout(fire, delay));
      },
      cancel: async (id) => {
        const t = timers.get(id);
        if (t) clearTimeout(t);
        timers.delete(id);
        const n = scheduled.get(id);
        scheduled.delete(id);
        if (n) cb.onNotify?.(n, 'cancelled');
      },
      list: async () => [...scheduled.values()],
    },

    storage: {
      put: async (f) => {
        const fileId = newId();
        const stored: StoredFile = { fileId, uri: `data:${f.mime};base64,${f.base64}`, status: 'local' };
        files.set(fileId, { ...stored, name: f.name, mime: f.mime, base64: f.base64 });
        const now = nowIso();
        o.driver.run(
          'INSERT INTO core_files (id, tenant_id, app_id, name, mime, size, uploaded_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)',
          [fileId, 'mock-tenant', o.manifest().id, f.name, f.mime, b64Len(f.base64), now, now],
        );
        noteWrite();
        return stored;
      },
      get: async (fileId) => {
        const f = files.get(fileId);
        const row = o.driver.all('SELECT uploaded_at FROM core_files WHERE id = ? AND deleted_at IS NULL', [fileId])[0];
        if (!f || !row) throw new BridgeError('NOT_FOUND', 'Không có file này');
        return { fileId, uri: f.uri, status: f.status };
      },
      remove: async (fileId) => {
        files.delete(fileId);
        const now = nowIso();
        o.driver.run('UPDATE core_files SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL', [now, now, fileId]);
        noteWrite();
      },
    },

    net: {
      fetch: async (req, isAllowed) => {
        if (o.netMode() === 'offline') throw new BridgeError('OFFLINE', 'Đang offline — không gửi request');
        let url = req.url;
        let method = req.method;
        let body = req.body;
        for (let hop = 0; hop <= MAX_HOPS; hop++) {
          // Mỗi bước (kể cả bước đầu) PHẢI qua isAllowed trước khi gửi — domain lạ không bao giờ rời máy.
          if (!isAllowed(url)) {
            let host = '';
            try {
              host = new URL(url).hostname;
            } catch {
              /* url hỏng */
            }
            throw new BridgeError('NET_BLOCKED', 'Chuyển hướng tới domain không có trong danh sách network của app', host);
          }
          let res;
          try {
            res = await o.hopFetch({ url, method, headers: req.headers, body, timeoutMs: req.timeoutMs });
          } catch (e) {
            if (e instanceof BridgeError) throw e;
            throw new BridgeError('NET_ERROR', (e as Error).message || 'Lỗi mạng');
          }
          const loc = res.headers['location'] ?? res.headers['Location'];
          if (res.status >= 300 && res.status < 400 && loc) {
            url = new URL(loc, url).toString();
            if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== 'GET' && method !== 'HEAD')) {
              method = 'GET';
              body = null;
            }
            continue;
          }
          return res;
        }
        throw new BridgeError('NET_ERROR', `Quá ${MAX_HOPS} lần chuyển hướng`);
      },
    },

    ui: {
      toast: (text) => cb.onToast?.(text),
      pickImage: async (opts) => {
        const picked = (await cb.pickImage?.(opts)) ?? [];
        const out: { fileId: string; uri: string; mime: string }[] = [];
        for (const p of picked) {
          const s = await host.storage.put(p);
          out.push({ fileId: s.fileId, uri: s.uri, mime: p.mime });
        }
        return { files: out };
      },
      share: async (s) => {
        await cb.share?.(s);
      },
    },

    intent: {
      receivers: (type, version): ReceiverInfo[] => {
        const out: ReceiverInfo[] = [];
        for (const m of o.bus.peers()) {
          for (const r of m.intents?.receives ?? []) {
            if (r.type === type && (version === null || r.version === version)) {
              out.push({ appId: m.id, type: r.type, version: r.version, schema: r.schema });
            }
          }
        }
        return out;
      },
      deliver: (i) => o.bus.deliver({ ...i, from: o.manifest().id }),
    },
  };

  return { host, pending: () => pending, resetPending: () => void (pending = 0) };
}
