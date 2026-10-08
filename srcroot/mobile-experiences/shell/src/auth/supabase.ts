// Auth/session (api-auth, vòng 1: Email OTP). Session lưu trong Keystore; không hết hạn khi offline
// vì supabase-js chỉ refresh khi gọi server.
import 'react-native-url-polyfill/auto';
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

export function tenantIdOf(accessToken: string): string | null {
  try {
    const payload = JSON.parse(atob(accessToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.tenant_id ?? null;
  } catch {
    return null;
  }
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
  } catch (e) {
    if (cached && cached.expiresAt > nowSec) return { token: cached.token, expires_at: cached.expiresAt };
    throw new OfflineError('Không có mạng và không có token còn hạn');
  }
}
