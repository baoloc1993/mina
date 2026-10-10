// Cấu hình đọc từ biến môi trường lúc build (EXPO_PUBLIC_*). `make dev` nạp chúng từ deployment/local/.env.
// Không có giá trị mặc định cho khoá: thiếu thì lỗi to, không chạy nửa vời.
function need(name: string, v: string | undefined): string {
  if (!v) throw new Error(`Thiếu biến môi trường ${name} (xem deployment/.env.example)`);
  return v;
}

import { parseProviders } from './auth/providers';

export const config = {
  oauthProviders: parseProviders(process.env.EXPO_PUBLIC_OAUTH_PROVIDERS),
  supabaseUrl: need('EXPO_PUBLIC_SUPABASE_URL', process.env.EXPO_PUBLIC_SUPABASE_URL),
  supabaseAnonKey: need('EXPO_PUBLIC_SUPABASE_ANON_KEY', process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY),
  powersyncUrl: need('EXPO_PUBLIC_POWERSYNC_URL', process.env.EXPO_PUBLIC_POWERSYNC_URL),
};
