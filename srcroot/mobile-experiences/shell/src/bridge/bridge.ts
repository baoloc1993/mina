// Bridge JSON-RPC 2.0 — contract miniapp-sdk-v0 (SDK 0.1.1, ARCHITECTURE.md §5).
// THUẦN TS: shell và mock SDK trên trình duyệt chạy CÙNG mã này, mọi hiệu ứng đi qua `Host`.
// Thứ tự kiểm (bất biến): request hợp lệ → method có thật → scope → chỉ đọc → tham số → thực thi.
// Từ chối ở bước nào thì KHÔNG có tác dụng phụ (Host không được gọi lần nào) — bảng kỳ vọng `matrix.ts` canh điều này.
import Ajv from 'ajv';
import { isAllowedUrl, parseUrl } from './netGuard';
import { guardSql, SqlRejected, type GuardContext } from './sqlGuard';
import {
  BridgeError,
  type BridgeContext,
  type ErrorCode,
  type Manifest,
  type RpcRequest,
  type RpcResponse,
  type Stmt,
} from './types';

export * from './types';
export { SqlRejected } from './sqlGuard';

export const SDK_VERSION = '0.1.1';
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_INTENT_BYTES = 64 * 1024;
export const MAX_NET_BODY_BYTES = 5 * 1024 * 1024;
const MAX_TOAST = 120;
const MIME_FILTER = /^[A-Za-z0-9.+-]+\/([A-Za-z0-9.+-]+|\*)$/;

/** Bộ lọc MIME của `ui.pickFile` (danh sách rỗng = nhận mọi loại; `image/*` khớp mọi `image/…`). Shell và mock dùng chung. */
export function matchesMime(filter: string[], mime: string): boolean {
  if (!filter.length) return true;
  const m = mime.toLowerCase();
  return filter.some((f) => {
    const x = f.toLowerCase();
    return x.endsWith('/*') ? m.startsWith(x.slice(0, -1)) : x === m;
  });
}

const ERROR_CODES = new Set<ErrorCode>([
  'INVALID_REQUEST', 'SCOPE_DENIED', 'SQL_REJECTED', 'OFFLINE', 'INTERNAL', 'READ_ONLY', 'NOT_FOUND',
  'INTENT_REJECTED', 'INTENT_NO_HANDLER', 'NET_BLOCKED', 'NET_ERROR', 'PERMISSION_DENIED', 'APP_SUSPENDED',
]);

/** Scope hợp lệ trong manifest v0 (shell/CLI từ chối `BAD_MANIFEST` khi gặp scope lạ). */
export const KNOWN_SCOPES = [
  'db', 'db.own',
  'core.tags:read', 'core.tags:write', 'core.contacts:read', 'core.contacts:write', 'core.files:read', 'core.files:write',
  'intent.send', 'notify.local', 'storage.files', 'net', 'ui.native', 'auth.token',
] as const;

/** Tiền tố bảng vật lý của app trong SQLite/Postgres: `<table_prefix>_`. */
export function physicalPrefix(tablePrefix: string): string {
  return `${tablePrefix}_`;
}

function hasScope(m: Manifest, scope: string): boolean {
  const have = new Set(m.scopes);
  if (have.has(scope)) return true;
  if (scope === 'db.own') return have.has('db');
  if (scope.endsWith(':read')) return have.has(scope.replace(/:read$/, ':write')); // ghi gồm đọc
  return false;
}

// ---------- kiểm tham số ----------
const bad = (m: string): never => {
  throw new BridgeError('INVALID_REQUEST', m);
};
type P = Record<string, unknown>;
const str = (p: P, k: string, min = 1, max = 4096): string => {
  const v = p[k];
  if (typeof v !== 'string' || v.length < min || v.length > max) bad(`"${k}" phải là chuỗi ${min}–${max} ký tự`);
  return v as string;
};
const optStr = (p: P, k: string, max: number): string | null => {
  const v = p[k];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || v.length > max) bad(`"${k}" phải là chuỗi ≤ ${max} ký tự`);
  return v as string;
};
const obj = (v: unknown, what: string): P => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) bad(`${what} phải là object`);
  return v as P;
};
const arrParams = (v: unknown): unknown[] => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) bad('"params" phải là mảng');
  return v as unknown[];
};

const ajv = new Ajv({ allErrors: true, strict: false });
const validators = new Map<string, ReturnType<Ajv['compile']>>();
function validatorFor(schema: unknown) {
  const key = JSON.stringify(schema);
  let v = validators.get(key);
  if (!v) {
    v = ajv.compile(schema as object);
    validators.set(key, v);
  }
  return v;
}

function needTenant(ctx: BridgeContext): string {
  const t = ctx.host.tenantId();
  if (!t) throw new BridgeError('INTERNAL', 'Chưa có phiên đăng nhập');
  return t;
}

function guardCtx(ctx: BridgeContext, includeDeleted = false): GuardContext {
  return {
    allowedTables: ctx.manifest.tables,
    prefix: physicalPrefix(ctx.tablePrefix),
    tenantId: needTenant(ctx),
    now: ctx.host.now(),
    includeDeleted,
  };
}

function guardStmt(ctx: BridgeContext, sql: unknown, params: unknown, includeDeleted = false) {
  if (typeof sql !== 'string') bad('"sql" phải là chuỗi');
  return guardSql(sql as string, arrParams(params), guardCtx(ctx, includeDeleted));
}

// ---------- định nghĩa method ----------
interface MethodDef {
  scopes: string[]; // phải có TẤT CẢ
  /** true nếu method (với tham số thô này) ghi dữ liệu → bị chặn khi chỉ đọc. Phải chịu được tham số hỏng. */
  write?: (raw: P) => boolean;
  run(ctx: BridgeContext, raw: P): Promise<unknown>;
}

const sqlLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

const METHODS: Record<string, MethodDef> = {
  // ---- sdk (luôn được phép) ----
  'sdk.ready': {
    scopes: [],
    run: async (ctx) => {
      ctx.host.lifecycle.ready();
      return true;
    },
  },
  'sdk.suspended': {
    scopes: [],
    run: async (ctx) => {
      ctx.host.lifecycle.suspended();
      return true;
    },
  },
  'sdk.info': {
    scopes: [],
    run: async (ctx) => {
      const i = ctx.host.sdkInfo();
      return {
        appId: ctx.manifest.id,
        version: ctx.manifest.version,
        sdkVersion: i.sdkVersion,
        platform: i.platform,
        readOnly: ctx.host.isReadOnly(),
      };
    },
  },

  // ---- db ----
  'db.query': {
    scopes: ['db.own'],
    run: async (ctx, raw) => {
      const g = guardStmt(ctx, raw.sql, raw.params, raw.includeDeleted === true);
      if (g.kind !== 'select') throw new BridgeError('SQL_REJECTED', 'db.query chỉ nhận SELECT');
      return ctx.host.db.all(g.sql, g.params);
    },
  },
  'db.execute': {
    scopes: ['db.own'],
    write: () => true,
    run: async (ctx, raw) => {
      const g = guardStmt(ctx, raw.sql, raw.params);
      if (g.kind === 'select') throw new BridgeError('SQL_REJECTED', 'db.execute không nhận SELECT');
      await ctx.host.db.run(g.sql, g.params);
      return true;
    },
  },
  'db.transaction': {
    scopes: ['db.own'],
    write: () => true,
    run: async (ctx, raw) => {
      const list = raw.statements;
      if (!Array.isArray(list) || list.length < 1 || list.length > 100) bad('"statements" phải là mảng 1–100 câu');
      // Guard TẤT CẢ trước khi chạy câu nào — một câu hỏng thì không câu nào được chạy.
      const stmts: Stmt[] = (list as unknown[]).map((s) => {
        const o = obj(s, 'mỗi câu');
        const g = guardStmt(ctx, o.sql, o.params);
        if (g.kind === 'select') throw new BridgeError('SQL_REJECTED', 'transaction không nhận SELECT');
        return { sql: g.sql, params: g.params };
      });
      await ctx.host.db.transaction(stmts);
      return true;
    },
  },

  // ---- core ----
  'core.tags.list': {
    scopes: ['core.tags:read'],
    run: async (ctx) =>
      ctx.host.db.all('SELECT id, name, color FROM core_tags WHERE deleted_at IS NULL ORDER BY name', []),
  },
  'core.tags.create': {
    scopes: ['core.tags:write'],
    write: () => true,
    run: async (ctx, raw) => {
      const name = str(raw, 'name', 1, 100).trim();
      if (!name) bad('"name" không được rỗng');
      const color = optStr(raw, 'color', 7);
      if (color !== null && !/^#[0-9a-fA-F]{6}$/.test(color)) bad('"color" phải dạng #RRGGBB');
      const tenant = needTenant(ctx);
      const id = ctx.host.newId();
      const now = ctx.host.now();
      await ctx.host.db.run(
        'INSERT INTO core_tags (id, tenant_id, name, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        [id, tenant, name, color, now, now],
      );
      return { id, name, color };
    },
  },
  'core.contacts.search': {
    scopes: ['core.contacts:read'],
    run: async (ctx, raw) => {
      const q = typeof raw.q === 'string' ? raw.q : bad('"q" phải là chuỗi');
      if ((q as string).length > 100) bad('"q" tối đa 100 ký tự');
      const like = `%${sqlLike(q as string)}%`;
      return ctx.host.db.all(
        "SELECT id, name, phone, email, note FROM core_contacts WHERE deleted_at IS NULL AND (name LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\') ORDER BY name LIMIT 50",
        [like, like, like],
      );
    },
  },
  'core.contacts.create': {
    scopes: ['core.contacts:write'],
    write: () => true,
    run: async (ctx, raw) => {
      const name = str(raw, 'name', 1, 100).trim();
      if (!name) bad('"name" không được rỗng');
      const phone = optStr(raw, 'phone', 30);
      const email = optStr(raw, 'email', 200);
      const note = optStr(raw, 'note', 1000);
      const tenant = needTenant(ctx);
      const id = ctx.host.newId();
      const now = ctx.host.now();
      await ctx.host.db.run(
        'INSERT INTO core_contacts (id, tenant_id, name, phone, email, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [id, tenant, name, phone, email, note, now, now],
      );
      return { id, name, phone, email, note };
    },
  },
  'core.files.get': {
    scopes: ['core.files:read'],
    run: async (ctx, raw) => {
      const id = str(raw, 'id', 1, 64);
      const rows = (await ctx.host.db.all(
        'SELECT id, app_id, name, mime, size, uploaded_at FROM core_files WHERE id = ? AND deleted_at IS NULL',
        [id],
      )) as unknown[];
      if (!rows.length) throw new BridgeError('NOT_FOUND', 'Không có file này');
      return rows[0];
    },
  },
  'core.files.list': {
    scopes: ['core.files:read'],
    run: async (ctx, raw) => {
      const appId = optStr(raw, 'appId', 200);
      return appId
        ? ctx.host.db.all(
            'SELECT id, app_id, name, mime, size, uploaded_at FROM core_files WHERE deleted_at IS NULL AND app_id = ? ORDER BY created_at DESC LIMIT 200',
            [appId],
          )
        : ctx.host.db.all(
            'SELECT id, app_id, name, mime, size, uploaded_at FROM core_files WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 200',
            [],
          );
    },
  },

  // ---- intent ----
  'intent.send': {
    scopes: ['intent.send'],
    write: (raw) => raw.mode !== 'open', // `create` (mặc định) ghi dữ liệu ở app nhận → bị chặn khi chỉ đọc
    run: async (ctx, raw) => {
      const type = str(raw, 'type', 1, 100);
      const mode = raw.mode === undefined ? 'create' : raw.mode;
      if (mode !== 'create' && mode !== 'open') bad('"mode" phải là "create" hoặc "open"');
      const payload = raw.payload === undefined ? {} : raw.payload;
      let size = 0;
      try {
        size = JSON.stringify(payload)?.length ?? 0;
      } catch {
        throw new BridgeError('INTENT_REJECTED', 'payload không phải JSON hợp lệ');
      }
      const declared = ctx.manifest.intents?.sends?.find(
        (s) => s.type === type && (raw.version === undefined || s.version === raw.version),
      );
      if (!declared) throw new BridgeError('SCOPE_DENIED', `Manifest không khai "${type}" trong intents.sends`);
      if (size > MAX_INTENT_BYTES) throw new BridgeError('INTENT_REJECTED', 'payload quá 64 KB');
      const receivers = ctx.host.intent.receivers(type, declared.version).filter((r) => r.appId !== ctx.manifest.id);
      if (!receivers.length) {
        if (ctx.host.intent.receivers(type, declared.version).length) {
          throw new BridgeError('INTENT_REJECTED', 'App không gửi intent cho chính nó');
        }
        throw new BridgeError('INTENT_NO_HANDLER', `Không có app nào nhận "${type}"`);
      }
      const target = receivers[0]; // nhiều app nhận cùng type: vòng 3 chọn app cài trước (hỏi + nhớ ở vòng 8)
      const validate = validatorFor(target.schema);
      if (!validate(payload)) {
        const first = validate.errors?.[0];
        throw new BridgeError(
          'INTENT_REJECTED',
          `Payload không hợp lệ: ${first?.message ?? 'sai schema'}`,
          first ? `${first.instancePath || ''}${(first.params as { missingProperty?: string })?.missingProperty ? '/' + (first.params as { missingProperty: string }).missingProperty : ''}` || '/' : undefined,
        );
      }
      const status = await ctx.host.intent.deliver({
        type,
        version: declared.version,
        payload,
        mode: mode as 'create' | 'open',
        to: target.appId,
      });
      return { status };
    },
  },

  // ---- notify ----
  'notify.schedule': {
    scopes: ['notify.local'],
    run: async (ctx, raw) => {
      const id = str(raw, 'id', 1, 64);
      const at = typeof raw.at === 'number' ? raw.at : typeof raw.at === 'string' ? Date.parse(raw.at) : NaN;
      if (!Number.isFinite(at)) bad('"at" phải là thời điểm (epoch ms hoặc ISO)');
      const title = str(raw, 'title', 1, 100);
      const body = optStr(raw, 'body', 500) ?? '';
      const ref = optStr(raw, 'ref', 500);
      await ctx.host.notify.schedule({ id, at, title, body, ref });
      return true;
    },
  },
  'notify.cancel': {
    scopes: ['notify.local'],
    run: async (ctx, raw) => {
      await ctx.host.notify.cancel(str(raw, 'id', 1, 64));
      return true;
    },
  },
  'notify.list': { scopes: ['notify.local'], run: (ctx) => ctx.host.notify.list() },

  // ---- storage ----
  'storage.put': {
    scopes: ['storage.files'],
    write: () => true,
    run: async (ctx, raw) => {
      const name = str(raw, 'name', 1, 255);
      const mime = str(raw, 'mime', 3, 100);
      if (!/^[\w.+-]+\/[\w.+-]+$/.test(mime)) bad('"mime" không hợp lệ');
      const base64 = str(raw, 'base64', 0, Math.ceil((MAX_FILE_BYTES * 4) / 3) + 8);
      if (Math.floor((base64.length * 3) / 4) > MAX_FILE_BYTES) bad('File quá 50 MB');
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) bad('"base64" không hợp lệ');
      return ctx.host.storage.put({ name, mime, base64 });
    },
  },
  'storage.get': {
    scopes: ['storage.files'],
    run: async (ctx, raw) => ctx.host.storage.get(str(raw, 'fileId', 1, 64)),
  },
  'storage.remove': {
    scopes: ['storage.files'],
    write: () => true,
    run: async (ctx, raw) => {
      await ctx.host.storage.remove(str(raw, 'fileId', 1, 64));
      return true;
    },
  },

  // ---- net ----
  'net.fetch': {
    scopes: ['net'],
    run: async (ctx, raw) => {
      const url = str(raw, 'url', 1, 4096);
      if (!parseUrl(url)) bad('"url" không hợp lệ');
      const method = (typeof raw.method === 'string' ? raw.method : 'GET').toUpperCase();
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method)) bad('"method" không hợp lệ');
      const headers: Record<string, string> = {};
      if (raw.headers !== undefined) {
        const h = obj(raw.headers, '"headers"');
        const keys = Object.keys(h);
        if (keys.length > 50) bad('"headers" tối đa 50 mục');
        for (const k of keys) {
          if (typeof h[k] !== 'string') bad('giá trị header phải là chuỗi');
          headers[k] = h[k] as string;
        }
      }
      const body = optStr(raw, 'body', 1024 * 1024);
      let timeoutMs = 15000;
      if (raw.timeoutMs !== undefined) {
        if (typeof raw.timeoutMs !== 'number' || !(raw.timeoutMs > 0)) bad('"timeoutMs" phải là số dương');
        timeoutMs = Math.min(raw.timeoutMs as number, 30000);
      }
      const allow = (u: string) => isAllowedUrl(u, ctx.manifest.network);
      // Chặn TRƯỚC khi hỏi mạng: domain ngoài danh sách không bao giờ rời máy, kể cả khi đang offline.
      if (!allow(url)) throw new BridgeError('NET_BLOCKED', 'Domain không có trong danh sách network của app', parseUrl(url)?.hostname);
      const res = await ctx.host.net.fetch({ url, method, headers, body, timeoutMs }, allow);
      if (res.body.length > MAX_NET_BODY_BYTES) throw new BridgeError('NET_ERROR', 'Phản hồi quá 5 MB');
      return res;
    },
  },

  // ---- ui ----
  'ui.toast': {
    scopes: ['ui.native'],
    run: async (ctx, raw) => {
      const text = str(raw, 'text', 1, 10_000);
      ctx.host.ui.toast(text.length > MAX_TOAST ? text.slice(0, MAX_TOAST - 1) + '…' : text);
      return true;
    },
  },
  'ui.pickImage': {
    scopes: ['ui.native', 'storage.files'],
    write: () => true,
    run: async (ctx, raw) => ctx.host.ui.pickImage({ multiple: raw.multiple === true }),
  },
  'ui.pickFile': {
    // SDK 0.1.1 — thêm vào dòng 0.x ở mức patch (DECISIONS 2026-10-09) để range `^0.1` của app cũ vẫn chứa SDK.
    scopes: ['ui.native', 'storage.files'],
    write: () => true,
    run: async (ctx, raw) => {
      let mime: string[] = [];
      if (raw.mime !== undefined && raw.mime !== null) {
        if (!Array.isArray(raw.mime) || raw.mime.length > 10) bad('"mime" phải là mảng ≤ 10 chuỗi');
        mime = (raw.mime as unknown[]).map((m) => {
          if (typeof m !== 'string' || !MIME_FILTER.test(m)) bad('"mime" chứa loại không hợp lệ (vd "application/pdf", "image/*")');
          return m as string;
        });
      }
      return ctx.host.ui.pickFile({ mime, multiple: raw.multiple === true });
    },
  },
  'ui.share': {
    scopes: ['ui.native'],
    run: async (ctx, raw) => {
      const title = optStr(raw, 'title', 200) ?? '';
      const text = optStr(raw, 'text', 5000) ?? '';
      const url = optStr(raw, 'url', 2048);
      if (!text && !url) bad('Cần "text" hoặc "url" để chia sẻ');
      await ctx.host.ui.share({ title, text, url });
      return true;
    },
  },

  // ---- sync (luôn được phép) ----
  'sync.status': { scopes: [], run: async (ctx) => ctx.host.sync.status() },

  // ---- auth ----
  'auth.getAppToken': {
    scopes: ['auth.token'],
    // app_id lấy từ manifest, KHÔNG từ tham số app truyền.
    run: (ctx) => ctx.host.auth.appToken(ctx.manifest.id),
  },
};

/** Danh sách method + scope cần — dùng cho bảng kỳ vọng và tài liệu. */
export const METHOD_TABLE = Object.entries(METHODS).map(([method, d]) => ({
  method,
  scopes: d.scopes,
  writes: !!d.write,
}));

function fail(id: RpcResponse['id'], e: unknown): RpcResponse {
  if (e instanceof BridgeError) {
    return { jsonrpc: '2.0', id, error: { code: e.code, message: e.message, ...(e.detail ? { detail: e.detail } : {}) } };
  }
  if (e instanceof SqlRejected) return { jsonrpc: '2.0', id, error: { code: 'SQL_REJECTED', message: e.message } };
  const code = (e as { code?: unknown })?.code;
  if (typeof code === 'string' && ERROR_CODES.has(code as ErrorCode)) {
    const detail = (e as { detail?: unknown }).detail;
    return {
      jsonrpc: '2.0',
      id,
      error: { code: code as ErrorCode, message: (e as Error).message, ...(typeof detail === 'string' ? { detail } : {}) },
    };
  }
  return { jsonrpc: '2.0', id, error: { code: 'INTERNAL', message: (e as Error)?.message ?? 'Lỗi nội bộ' } };
}

export async function handleRpc(req: RpcRequest, ctx: BridgeContext): Promise<RpcResponse> {
  const id = req?.id ?? null;
  if (!req || req.jsonrpc !== '2.0' || typeof req.method !== 'string' || (typeof id !== 'number' && typeof id !== 'string')) {
    return fail(id, new BridgeError('INVALID_REQUEST', 'JSON-RPC không hợp lệ'));
  }
  const def = Object.prototype.hasOwnProperty.call(METHODS, req.method) ? METHODS[req.method] : undefined;
  if (!def) return fail(id, new BridgeError('SCOPE_DENIED', `Method không có trong SDK v0: ${req.method}`));
  const missing = def.scopes.find((s) => !hasScope(ctx.manifest, s));
  if (missing) {
    return fail(id, new BridgeError('SCOPE_DENIED', `Manifest không khai scope "${missing}" cho ${req.method}`));
  }
  let raw: P;
  try {
    raw = req.params === undefined || req.params === null ? {} : obj(req.params, '"params"');
  } catch (e) {
    return fail(id, e);
  }
  try {
    if (def.write?.(raw) && ctx.host.isReadOnly()) {
      return fail(id, new BridgeError('READ_ONLY', 'Tài khoản đang ở chế độ chỉ đọc — cần mạng để xác minh lại'));
    }
    return { jsonrpc: '2.0', id, result: await def.run(ctx, raw) };
  } catch (e) {
    return fail(id, e);
  }
}
