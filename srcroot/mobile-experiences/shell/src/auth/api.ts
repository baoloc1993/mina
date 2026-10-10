// Gọi server của platform-backend: catalog, khoá ký tin cậy, RPC cài/gỡ/xếp lại. Lỗi → PackageError có mã (khuôn lỗi vòng 2:
// Edge Function trả `{error: CODE}`; RPC trả `message = CODE` và LUÔN HTTP 400 — chỉ tin message).
import { config } from '../config';
import { PackageError, type CatalogResponse, type PackageErrorCode } from '../packages/types';
import { catalogStatusError, UnauthorizedError } from './httpStatus';
import { rateLimitDelayMs } from '../store/retryAfter';
import { supabase } from './supabase';

export { UnauthorizedError } from './httpStatus';

const KNOWN: PackageErrorCode[] = [
  'QUOTA_EXCEEDED', 'APP_NOT_AVAILABLE', 'NO_VERSION', 'APP_NOT_INSTALLED', 'NO_TENANT', 'SESSION_REVOKED',
];

function isNetwork(e: unknown): boolean {
  const m = String((e as Error)?.message ?? e).toLowerCase();
  return m.includes('network') || m.includes('failed to fetch') || m.includes('timeout') || m.includes('abort') || m.includes('connect');
}

export function mapRpcError(e: { message?: string } | null): PackageError | null {
  if (!e) return null;
  const msg = (e.message ?? '').trim();
  const hit = KNOWN.find((k) => msg.includes(k));
  if (hit) return new PackageError(hit, msg);
  if (isNetwork(e)) return new PackageError('OFFLINE', 'Không có mạng');
  return new PackageError('INTERNAL', msg || 'Lỗi máy chủ');
}

async function session() {
  const { data } = await supabase.auth.getSession();
  if (!data.session) throw new UnauthorizedError('Chưa đăng nhập');
  return data.session;
}

export async function fetchCatalog(): Promise<CatalogResponse> {
  const s = await session();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10000);
  try {
    const res = await fetch(`${config.supabaseUrl}/functions/v1/catalog`, {
      signal: ctl.signal,
      headers: { authorization: `Bearer ${s.access_token}`, apikey: config.supabaseAnonKey, connection: 'close' },
    });
    const failure = catalogStatusError(res.status);
    if (failure) throw failure;
    return (await res.json()) as CatalogResponse;
  } catch (e) {
    if (e instanceof UnauthorizedError || e instanceof PackageError) throw e;
    throw new PackageError('OFFLINE', 'Không có mạng');
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchTrustedKeys(): Promise<Record<string, string>> {
  const { data, error } = await supabase.from('signing_keys').select('key_id, public_key').eq('status', 'active');
  if (error) throw mapRpcError(error) ?? new PackageError('INTERNAL', error.message);
  return Object.fromEntries((data ?? []).map((k: { key_id: string; public_key: string }) => [k.key_id, k.public_key]));
}

export async function installApp(appId: string): Promise<void> {
  const { error } = await supabase.rpc('install_app', { p_app_id: appId });
  const m = mapRpcError(error);
  if (m) throw m;
}
export async function uninstallApp(appId: string): Promise<void> {
  const { error } = await supabase.rpc('uninstall_app', { p_app_id: appId });
  const m = mapRpcError(error);
  if (m) throw m;
}
export async function reorderApps(appIds: string[]): Promise<void> {
  const { error } = await supabase.rpc('reorder_apps', { p_app_ids: appIds });
  const m = mapRpcError(error);
  if (m) throw m;
}

/** Bảng vật lý của một app (PostgREST, RLS giới hạn app hiển thị cho tenant). */
export async function serverTablesOf(appId: string): Promise<string[]> {
  const { data, error } = await supabase.from('app_tables').select('table_name').eq('app_id', appId);
  if (error) throw mapRpcError(error) ?? new PackageError('INTERNAL', error.message);
  return (data ?? []).map((r: { table_name: string }) => r.table_name);
}

/** Id các dòng còn sống của một bảng app (RLS lọc theo tenant), theo trang. */
export async function liveIds(table: string, from: number, size: number): Promise<string[]> {
  const { data, error } = await supabase.from(table).select('id').is('deleted_at', null).order('id').range(from, from + size - 1);
  if (error) throw mapRpcError(error) ?? new PackageError('INTERNAL', error.message);
  return (data ?? []).map((r: { id: string }) => r.id);
}

/** Gửi lô DELETE (xoá mềm) qua `upload` — dùng cho "xoá hẳn dữ liệu". */
export async function uploadDeletes(table: string, ids: string[]): Promise<void> {
  const s = await session();
  const res = await fetch(`${config.supabaseUrl}/functions/v1/upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${s.access_token}`, apikey: config.supabaseAnonKey },
    body: JSON.stringify({ ops: ids.map((id) => ({ op: 'DELETE', table, id })) }),
  }).catch(() => {
    throw new PackageError('OFFLINE', 'Không có mạng');
  });
  if (res.status === 401) throw new UnauthorizedError('Phiên đăng nhập hết hiệu lực');
  if (res.status === 403) throw new PackageError('INTERNAL', 'READ_ONLY');
  if (res.status === 429) {
    const b = (await res.json().catch(() => ({}))) as { retry_after_s?: unknown };
    await new Promise((r) => setTimeout(r, rateLimitDelayMs(res.headers.get('retry-after'), b.retry_after_s)));
    throw new PackageError('OFFLINE', 'Máy chủ đang giới hạn tần suất — thử lại sau');
  }
  if (!res.ok) throw new PackageError('INTERNAL', `upload HTTP ${res.status}`);
}
