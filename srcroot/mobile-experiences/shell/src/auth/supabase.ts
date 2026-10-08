// Auth/session (api-auth): Email OTP + OAuth Google/Apple (expo-web-browser) + thiết bị. Session lưu Keystore; không hết hạn
// khi offline vì supabase-js chỉ refresh khi gọi server.
import 'react-native-url-polyfill/auto';
import { Platform } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import * as Device from 'expo-device';
import { createClient } from '@supabase/supabase-js';
import { config } from '../config';
import { secureSessionStorage } from '../store/secureKey';

export const supabase = createClient(config.supabaseUrl, config.supabaseAnonKey, {
  auth: {
    storage: secureSessionStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

export async function requestOtp(email: string): Promise<void> {
  const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
  if (error) throw error;
}

export async function verifyOtp(email: string, token: string): Promise<void> {
  const { error } = await supabase.auth.verifyOtp({ email, token, type: 'email' });
  if (error) throw error;
}

export type Provider = 'google' | 'apple';
export class ProviderUnavailable extends Error {
  readonly code = 'PROVIDER_UNAVAILABLE';
}

/** Đăng nhập / liên kết qua trình duyệt hệ thống. Local không có OAuth client ⇒ PROVIDER_UNAVAILABLE (không phải AC). */
export async function oauth(provider: Provider, link = false): Promise<void> {
  const redirectTo = 'minashell://auth-callback';
  const res = link
    ? await supabase.auth.linkIdentity({ provider, options: { redirectTo, skipBrowserRedirect: true } })
    : await supabase.auth.signInWithOAuth({ provider, options: { redirectTo, skipBrowserRedirect: true } });
  if (res.error || !res.data?.url) throw new ProviderUnavailable(res.error?.message ?? 'Chưa cấu hình nhà cung cấp');
  // Máy chủ local trả URL tới provider giả; kiểm trước khi mở để lỗi rõ ràng thay vì một trang lỗi của trình duyệt.
  const probe = await fetch(res.data.url, { redirect: 'manual' }).catch(() => null);
  if (!probe || probe.status >= 400) throw new ProviderUnavailable('Nhà cung cấp chưa được cấu hình');
  const r = await WebBrowser.openAuthSessionAsync(res.data.url, redirectTo);
  if (r.type !== 'success') return;
  const code = new URL(r.url).searchParams.get('code');
  if (code) {
    const ex = await supabase.auth.exchangeCodeForSession(code);
    if (ex.error) throw ex.error;
  }
}

export function tenantIdOf(accessToken: string): string | null {
  try {
    const payload = JSON.parse(atob(accessToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.tenant_id ?? null;
  } catch {
    return null;
  }
}

export function claimsOf(accessToken: string): { sub?: string; email?: string; tenant_id?: string; session_id?: string } {
  try {
    return JSON.parse(atob(accessToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return {};
  }
}

/** Ghi tên + nền tảng thiết bị này sau đăng nhập (RPC register_device; null/rỗng giữ giá trị cũ). */
export async function registerDevice(): Promise<void> {
  const name = Device.modelName || Device.deviceName || 'Thiết bị Android';
  await supabase.rpc('register_device', { p_name: name, p_platform: Platform.OS });
}

export interface DeviceRow {
  id: string;
  session_id: string;
  name: string | null;
  platform: string | null;
  last_seen_at: string;
  revoked_at: string | null;
}
export async function listDevices(): Promise<DeviceRow[]> {
  const { data, error } = await supabase
    .from('devices')
    .select('id, session_id, name, platform, last_seen_at, revoked_at')
    .is('revoked_at', null)
    .order('created_at');
  if (error) throw error;
  return (data ?? []) as DeviceRow[];
}
export async function revokeDevice(id: string): Promise<void> {
  const { error } = await supabase.rpc('revoke_device', { p_device_id: id });
  if (error) throw error;
}
export async function renameThisDevice(name: string): Promise<void> {
  const { error } = await supabase.rpc('register_device', { p_name: name, p_platform: Platform.OS });
  if (error) throw error;
}

/** Token ngắn hạn theo app (CAP-ID-03). Offline: dùng cache còn hạn, hết hạn thì lỗi OFFLINE. */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();
export class OfflineError extends Error {
  readonly code = 'OFFLINE';
}
export async function getAppToken(appId: string): Promise<{ token: string; expires_at: number }> {
  const cached = tokenCache.get(appId);
  const nowSec = Math.floor(Date.now() / 1000);
  try {
    const { data } = await supabase.auth.getSession();
    if (!data.session) throw new Error('NO_SESSION');
    const res = await fetch(`${config.supabaseUrl}/functions/v1/issue-app-token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${data.session.access_token}`,
        apikey: config.supabaseAnonKey,
      },
      body: JSON.stringify({ app_id: appId }),
    });
    if (!res.ok) throw new Error(`HTTP_${res.status}`);
    const body = (await res.json()) as { token: string; expires_at: number };
    tokenCache.set(appId, { token: body.token, expiresAt: body.expires_at });
    return body;
  } catch {
    if (cached && cached.expiresAt > nowSec) return { token: cached.token, expires_at: cached.expiresAt };
    throw new OfflineError('Không có mạng và không có token còn hạn');
  }
}
