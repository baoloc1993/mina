// Thông báo đăng nhập bằng tiếng Việt cho người dùng — không lộ chuỗi lỗi kỹ thuật của backend.
// Tách khỏi supabase.ts để test được bằng Jest (không kéo theo module native).

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateEmail(email: string): string | null {
  const e = email.trim();
  if (!e) return 'Nhập email trước khi gửi mã.';
  if (!EMAIL_RE.test(e)) return 'Email chưa đúng định dạng (ví dụ: ten@example.com).';
  return null;
}

export function validateCode(code: string): string | null {
  return /^\d{6}$/.test(code.trim()) ? null : 'Mã gồm đúng 6 chữ số.';
}

export function viAuthError(e: unknown, step: 'send' | 'verify'): string {
  const raw = e instanceof Error ? e.message : String(e ?? '');
  const m = raw.toLowerCase();
  if (m.includes('network') || m.includes('fetch failed') || m.includes('connectexception') || m.includes('timeout')) {
    return 'Không có kết nối mạng. Kiểm tra mạng rồi thử lại.';
  }
  if (m.includes('rate limit') || m.includes('too many') || m.includes('429') || m.includes('security purposes')) {
    return 'Thao tác quá nhanh. Đợi một lát rồi thử lại.';
  }
  if (step === 'verify' && (m.includes('expired') || m.includes('invalid'))) {
    return 'Mã sai hoặc đã hết hạn. Kiểm tra lại mã, hoặc bấm "Gửi lại mã".';
  }
  if (m.includes('email')) return 'Email không hợp lệ.';
  return step === 'send' ? 'Chưa gửi được mã. Thử lại sau ít phút.' : 'Chưa xác nhận được mã. Thử lại sau ít phút.';
}
