// Nhà cung cấp đăng nhập ngoài (Google / Apple) được BẬT ở bản build này — từ EXPO_PUBLIC_OAUTH_PROVIDERS ("google,apple").
// Mặc định KHÔNG có nhà nào: bản release production vòng 7 chỉ có Email OTP (chưa cấu hình OAuth; nút bấm vào sẽ trỏ
// tới trang lỗi 403 — dogfood vòng 7). Bật lại khi server có khoá thật (vòng 11 cùng iOS).
export type Provider = 'google' | 'apple';

export function parseProviders(raw: string | undefined): Provider[] {
  const out: Provider[] = [];
  for (const p of (raw ?? '').split(',').map((s) => s.trim().toLowerCase())) {
    if ((p === 'google' || p === 'apple') && !out.includes(p)) out.push(p);
  }
  return out;
}
