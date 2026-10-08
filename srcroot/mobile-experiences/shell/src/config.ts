// Cấu hình đọc từ biến môi trường lúc build (EXPO_PUBLIC_*). `make dev` nạp chúng từ deployment/local/.env.
// Không có giá trị mặc định cho khoá: thiếu thì lỗi to, không chạy nửa vời.
function need(name: string, v: string | undefined): string {
  if (!v) throw new Error(`Thiếu biến môi trường ${name} (xem deployment/.env.example)`);
  return v;
}

export const config = {
  supabaseUrl: need('EXPO_PUBLIC_SUPABASE_URL', process.env.EXPO_PUBLIC_SUPABASE_URL),
  supabaseAnonKey: need('EXPO_PUBLIC_SUPABASE_ANON_KEY', process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY),
  powersyncUrl: need('EXPO_PUBLIC_POWERSYNC_URL', process.env.EXPO_PUBLIC_POWERSYNC_URL),
};
