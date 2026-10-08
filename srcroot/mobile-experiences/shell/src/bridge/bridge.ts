// Bridge JSON-RPC 2.0 (contract miniapp-sdk-v0). Vòng 1: sdk.ready, db.query, db.execute, auth.getAppToken.
// Mọi method đều đi qua scope guard theo manifest; method lạ / thiếu scope → SCOPE_DENIED.
import { guardSql, SqlRejected, type GuardContext } from './sqlGuard';

export interface Manifest {
  id: string; // reverse-domain, vd "vn.app.hello"
  name: string;
  version: string;
  entry: string;
  scopes: string[]; // vd ["db", "auth.token"]
  tables: string[]; // tên ngắn, vd ["items"]
}

export interface RpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: { sql?: string; params?: unknown[]; [k: string]: unknown };
}
export interface RpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: string; message: string };
}

export interface BridgeDeps {
  manifest: Manifest;
  getTenantId(): string | null;
  now(): string;
  dbGetAll(sql: string, params: unknown[]): Promise<unknown[]>;
  dbExecute(sql: string, params: unknown[]): Promise<void>;
  getAppToken(appId: string): Promise<{ token: string; expires_at: number }>;
  onReady(): void;
}

// method → scope cần có trong manifest.scopes ('' = luôn được phép)
const METHOD_SCOPE: Record<string, string> = {
  'sdk.ready': '',
  'db.query': 'db',
  'db.execute': 'db',
  'auth.getAppToken': 'auth.token',
};

/** Tiền tố bảng: "vn.app.hello" → "app_hello_" (đoạn cuối của id). */
export function tablePrefix(appId: string): string {
  const last = appId.split('.').pop() ?? '';
  return `app_${last.replace(/[^a-z0-9]/gi, '_')}_`;
}

function err(id: RpcResponse['id'], code: string, message: string): RpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export async function handleRpc(req: RpcRequest, deps: BridgeDeps): Promise<RpcResponse> {
  const id = req?.id ?? null;
  if (!req || req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
    return err(id, 'INVALID_REQUEST', 'JSON-RPC không hợp lệ');
  }
  const need = METHOD_SCOPE[req.method];
  if (need === undefined) {
    return err(id, 'SCOPE_DENIED', `Method không có trong scope: ${req.method}`);
  }
  if (need !== '' && !deps.manifest.scopes.includes(need)) {
    return err(id, 'SCOPE_DENIED', `Manifest không khai scope "${need}" cho ${req.method}`);
  }

  try {
    switch (req.method) {
      case 'sdk.ready':
        deps.onReady();
        return { jsonrpc: '2.0', id, result: true };

      case 'db.query':
      case 'db.execute': {
        const tenantId = deps.getTenantId();
        if (!tenantId) return err(id, 'INTERNAL', 'Chưa có phiên đăng nhập');
        const ctx: GuardContext = {
          allowedTables: deps.manifest.tables,
          prefix: tablePrefix(deps.manifest.id),
          tenantId,
          now: deps.now(),
        };
        const g = guardSql(String(req.params?.sql ?? ''), req.params?.params ?? [], ctx);
        if (req.method === 'db.query') {
          if (g.kind !== 'select') return err(id, 'SQL_REJECTED', 'db.query chỉ nhận SELECT');
          return { jsonrpc: '2.0', id, result: await deps.dbGetAll(g.sql, g.params) };
        }
        if (g.kind === 'select') return err(id, 'SQL_REJECTED', 'db.execute không nhận SELECT');
        await deps.dbExecute(g.sql, g.params);
        return { jsonrpc: '2.0', id, result: true };
      }

      case 'auth.getAppToken':
        // app_id lấy từ manifest, KHÔNG từ tham số app truyền.
        return { jsonrpc: '2.0', id, result: await deps.getAppToken(deps.manifest.id) };
    }
  } catch (e) {
    if (e instanceof SqlRejected) return err(id, 'SQL_REJECTED', e.message);
    const code = (e as { code?: string }).code;
    if (code === 'OFFLINE') return err(id, 'OFFLINE', (e as Error).message);
    return err(id, 'INTERNAL', (e as Error).message);
  }
  return err(id, 'INTERNAL', 'không tới được');
}
