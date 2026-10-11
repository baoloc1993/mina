// Mã lỗi → câu tiếng Việt dễ hiểu + mã trong ngoặc (PRD §7 "Trạng thái lỗi", DESIGN-SYSTEM §5). Giọng trung tính.
// Mã giữ tiếng Anh in hoa như contract (ARCHITECTURE §5). Thuần TS.

const SENTENCES: Record<string, string> = {
  // gói / cài đặt (Package Manager)
  PACKAGE_TAMPERED: 'Gói không khớp chữ ký — đã huỷ, không cài',
  UNTRUSTED_KEY: 'Khoá ký không nằm trong danh sách tin cậy',
  SDK_TOO_OLD: 'App cần phiên bản Mina mới hơn — hãy cập nhật Mina',
  BAD_PACKAGE: 'Gói app không hợp lệ',
  BAD_MANIFEST: 'Thông tin khai báo của app không hợp lệ',
  MIGRATION_NOT_ADDITIVE: 'Bản này đổi cấu trúc dữ liệu theo cách không được phép — đã huỷ',
  MIGRATION_FAILED: 'Không nâng cấp được dữ liệu của app — đã hoàn tác',
  UPDATE_FAILED: 'Không cập nhật được app — bản cũ vẫn chạy',
  APP_REVOKED: 'Bản này đã bị thu hồi — cần mạng để cập nhật bản mới',
  NO_SAFE_VERSION: 'Chưa có bản an toàn để cài',
  PACKAGE_UNAVAILABLE: 'Chưa tải được gói app. Thử lại sau',
  QUOTA_EXCEEDED: 'Gói của bạn đã đủ số app — nâng gói để cài thêm',
  APP_NOT_AVAILABLE: 'App này không còn dành cho bạn',
  NO_VERSION: 'App chưa có bản nào để cài',
  APP_NOT_INSTALLED: 'App chưa được cài trên máy này',
  NO_TENANT: 'Tài khoản chưa gắn với không gian làm việc nào',
  // phiên / mạng
  SESSION_REVOKED: 'Phiên đăng nhập đã bị thu hồi — hãy đăng nhập lại',
  OFFLINE: 'Không có kết nối mạng — cần mạng để thực hiện',
  OTP_INVALID: 'Mã không đúng hoặc đã hết hạn',
  PROVIDER_UNAVAILABLE: 'Đăng nhập bằng nhà cung cấp này chưa được cấu hình trên máy này',
  // bridge / mini app
  READ_ONLY: 'Đang chỉ đọc — thay đổi được giữ lại và gửi khi xác minh lại',
  SCOPE_DENIED: 'App chưa được cấp quyền này',
  SQL_REJECTED: 'Câu lệnh dữ liệu của app không được chấp nhận',
  INVALID_REQUEST: 'Yêu cầu của app không hợp lệ',
  INTENT_REJECTED: 'Dữ liệu gửi sang app khác không đúng định dạng',
  INTENT_NO_HANDLER: 'Không có app nào nhận được yêu cầu này',
  NET_BLOCKED: 'Địa chỉ này không có trong danh sách app được phép gọi',
  NET_ERROR: 'Không gọi được địa chỉ mạng này. Thử lại sau',
  PERMISSION_DENIED: 'Bạn đã từ chối quyền này',
  APP_SUSPENDED: 'App đang tạm dừng',
  NOT_FOUND: 'Không tìm thấy mục này',
  FORBIDDEN: 'Không có quyền ghi',
  BAD_OP: 'Thay đổi sai định dạng',
  SCHEMA: 'Dữ liệu không khớp bảng',
  TABLE_NOT_ALLOWED: 'Bảng không thuộc app nào đã cài',
  INTERNAL: 'Có lỗi không mong muốn. Thử lại sau',
};

/** Câu mô tả (không kèm mã). Mã `MIGRATION_*` lạ → câu chung của migration; mã lạ khác → câu chung. */
export function errorSentence(code: string, opts: { provider?: string } = {}): string {
  if (code === 'PROVIDER_UNAVAILABLE' && opts.provider) {
    return `Đăng nhập bằng ${opts.provider} chưa được cấu hình trên máy này`;
  }
  const s = SENTENCES[code];
  if (s) return s;
  if (code.startsWith('MIGRATION_')) return SENTENCES.MIGRATION_FAILED;
  return 'Có lỗi xảy ra. Thử lại sau';
}

/** "Câu tiếng Việt (MÃ)" — dạng hiện cho người dùng. */
export function errorText(code: string, opts: { provider?: string } = {}): string {
  return `${errorSentence(code, opts)} (${code})`;
}

/** Lấy mã từ giá trị bắt được (PackageError / BridgeError / ProviderUnavailable / chuỗi). */
export function codeOf(e: unknown): string {
  if (typeof e === 'string') return /^[A-Z][A-Z0-9_]+$/.test(e) ? e : 'INTERNAL';
  if (e && typeof e === 'object' && 'code' in e) {
    const c = (e as { code?: unknown }).code;
    if (typeof c === 'string' && c) return c;
  }
  const msg = e instanceof Error ? e.message.toLowerCase() : '';
  if (msg.includes('network') || msg.includes('fetch failed') || msg.includes('timeout')) return 'OFFLINE';
  return 'INTERNAL';
}

/** Chuỗi hiện cho người dùng từ một lỗi bắt được. */
export function errorFrom(e: unknown, opts: { provider?: string } = {}): string {
  return errorText(codeOf(e), opts);
}
