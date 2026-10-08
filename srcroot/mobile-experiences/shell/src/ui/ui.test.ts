import { codeOf, errorFrom, errorSentence, errorText } from './errorText';
import { scopeLines } from './scopeText';
import { matchesConfirmText } from './confirmText';
import { hashId, iconBackground, iconLetter, iconTone, ICON_TONES } from './iconColor';
import { moveItem, sameOrder, slotFromPoint, slotOrigin, type GridGeometry } from './reorder';
import { formatGraceLeft, formatWhen, pendingText } from './format';
import { stepInfo } from './progress';
import { color, parseShadow, shadow, space, tapMin, fontSize } from './theme';

describe('errorText', () => {
  const codes = [
    'PACKAGE_TAMPERED', 'UNTRUSTED_KEY', 'SDK_TOO_OLD', 'UPDATE_FAILED', 'APP_REVOKED', 'INTENT_REJECTED', 'INTENT_NO_HANDLER',
    'NET_BLOCKED', 'NET_ERROR', 'PERMISSION_DENIED', 'READ_ONLY', 'NOT_FOUND', 'PROVIDER_UNAVAILABLE', 'QUOTA_EXCEEDED',
    'NO_SAFE_VERSION', 'APP_NOT_AVAILABLE', 'OFFLINE', 'OTP_INVALID', 'PACKAGE_UNAVAILABLE', 'BAD_MANIFEST', 'MIGRATION_FAILED',
    'MIGRATION_NOT_ADDITIVE', 'SESSION_REVOKED', 'INTERNAL',
  ];
  it('mọi mã ở PRD §7 có câu riêng (không rơi vào câu chung) và kèm mã trong ngoặc', () => {
    for (const c of codes) {
      expect(errorSentence(c)).not.toBe(errorSentence('KHONG_CO_MA_NAY'));
      expect(errorText(c).endsWith(`(${c})`)).toBe(true);
    }
  });
  it('mã MIGRATION_* lạ dùng câu migration; mã lạ khác dùng câu chung', () => {
    expect(errorSentence('MIGRATION_X')).toBe(errorSentence('MIGRATION_FAILED'));
    expect(errorText('ZZZ')).toBe('Có lỗi xảy ra. Thử lại sau (ZZZ)');
  });
  it('PROVIDER_UNAVAILABLE nêu tên nhà cung cấp', () => {
    expect(errorText('PROVIDER_UNAVAILABLE', { provider: 'Google' })).toBe('Đăng nhập bằng Google chưa được cấu hình trên máy này (PROVIDER_UNAVAILABLE)');
  });
  it('codeOf lấy mã từ lỗi có .code, chuỗi mã, lỗi mạng', () => {
    expect(codeOf(Object.assign(new Error('x'), { code: 'OFFLINE' }))).toBe('OFFLINE');
    expect(codeOf('APP_REVOKED')).toBe('APP_REVOKED');
    expect(codeOf(new Error('Network request failed'))).toBe('OFFLINE');
    expect(codeOf(new Error('boom'))).toBe('INTERNAL');
    expect(errorFrom(Object.assign(new Error('x'), { code: 'QUOTA_EXCEEDED' }))).toContain('QUOTA_EXCEEDED');
  });
});

describe('scopeLines', () => {
  it('dịch scope ra tiếng Việt, net đi cùng danh sách network', () => {
    const l = scopeLines(['db.own', 'notify.local', 'ui.native', 'net', 'core.tags:write'], ['vnexpress.net']);
    expect(l).toContain('Lưu dữ liệu riêng của app');
    expect(l).toContain('Thông báo');
    expect(l).toContain('Mạng tới vnexpress.net');
    expect(l).toContain('Thẻ dùng chung (đọc và ghi)');
  });
  it('db và db.own gộp một dòng; read+write gộp thành đọc và ghi', () => {
    expect(scopeLines(['db', 'db.own'], [])).toEqual(['Lưu dữ liệu riêng của app']);
    expect(scopeLines(['core.tags:read', 'core.tags:write'], [])).toEqual(['Thẻ dùng chung (đọc và ghi)']);
    expect(scopeLines(['core.contacts:read'], [])).toEqual(['Danh bạ dùng chung (chỉ đọc)']);
  });
  it('net không khai host vẫn có dòng; scope lạ giữ nguyên chữ', () => {
    expect(scopeLines(['net'], [])).toEqual(['Truy cập mạng']);
    expect(scopeLines(['xyz'], undefined)).toEqual(['xyz']);
    expect(scopeLines(undefined, undefined)).toEqual([]);
  });
});

describe('matchesConfirmText', () => {
  it('đúng chữ XOÁ (kể cả dạng tổ hợp rời) mới khớp', () => {
    expect(matchesConfirmText('XOÁ')).toBe(true);
    expect(matchesConfirmText('XOÁ')).toBe(true);
    expect(matchesConfirmText(' XOÁ ')).toBe(true);
  });
  it('sai hoa/thường hoặc thiếu dấu thì không khớp', () => {
    expect(matchesConfirmText('xoá')).toBe(false);
    expect(matchesConfirmText('XOA')).toBe(false);
    expect(matchesConfirmText('')).toBe(false);
  });
});

describe('iconColor', () => {
  it('ổn định theo id và luôn nằm trong bảng token', () => {
    expect(hashId('vn.app.hello')).toBe(hashId('vn.app.hello'));
    for (const id of ['a', 'vn.app.hello', 'vn.app.hello-cal', 'x'.repeat(50)]) {
      expect(ICON_TONES).toContain(iconTone(id));
      expect(Object.values(color)).toContain(iconBackground(id));
    }
  });
  it('app riêng luôn màu warning; chữ cái đầu viết hoa', () => {
    expect(iconTone('bất kỳ', true)).toBe('warning');
    expect(iconLetter('hello')).toBe('H');
    expect(iconLetter('  ép')).toBe('É');
    expect(iconLetter('')).toBe('?');
  });
});

describe('reorder', () => {
  const g: GridGeometry = { columns: 4, cellWidth: 90, cellHeight: 120, count: 6 };
  it('moveItem đưa phần tử sang đích, các ô giữa dồn lại', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveItem(['a', 'b', 'c', 'd'], 3, 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(moveItem(['a', 'b'], 0, 9)).toEqual(['b', 'a']);
    expect(moveItem(['a', 'b'], 5, 0)).toEqual(['a', 'b']);
    expect(moveItem([], 0, 0)).toEqual([]);
  });
  it('slotFromPoint/slotOrigin khớp nhau và kẹp biên', () => {
    expect(slotFromPoint(10, 10, g)).toBe(0);
    expect(slotFromPoint(100, 10, g)).toBe(1);
    expect(slotFromPoint(10, 130, g)).toBe(4);
    expect(slotFromPoint(999, 999, g)).toBe(5);
    expect(slotFromPoint(-50, -50, g)).toBe(0);
    for (let i = 0; i < g.count; i++) {
      const o = slotOrigin(i, g);
      expect(slotFromPoint(o.x + 1, o.y + 1, g)).toBe(i);
    }
  });
  it('sameOrder', () => {
    expect(sameOrder(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(sameOrder(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(sameOrder(['a'], ['a', 'b'])).toBe(false);
  });
});

describe('format', () => {
  const now = new Date(2026, 9, 9, 12, 0, 0);
  it('formatWhen', () => {
    expect(formatWhen(new Date(2026, 9, 9, 10, 41).toISOString(), now)).toBe('hôm nay 10:41');
    expect(formatWhen(new Date(2026, 9, 8, 9, 5).toISOString(), now)).toBe('hôm qua 09:05');
    expect(formatWhen(new Date(2026, 8, 1, 9, 5).toISOString(), now)).toBe('01/09 09:05');
    expect(formatWhen(new Date(2025, 8, 1, 9, 5).toISOString(), now)).toBe('01/09/2025 09:05');
    expect(formatWhen(null, now)).toBe('chưa lần nào');
  });
  it('formatGraceLeft, pendingText', () => {
    expect(formatGraceLeft(5 * 86_400_000 - 1000)).toBe('còn 5 ngày');
    expect(formatGraceLeft(3 * 3_600_000)).toBe('còn 3 giờ');
    expect(formatGraceLeft(1000)).toBe('còn dưới 1 giờ');
    expect(pendingText(0)).toContain('Không có');
    expect(pendingText(2)).toBe('2 thay đổi đang chờ gửi');
  });
});

describe('progress + theme', () => {
  it('stepInfo đủ 4 bước, phân số tăng dần', () => {
    const f = (['download', 'verify', 'extract', 'migrate', 'register', 'done'] as const).map((s) => stepInfo(s).fraction);
    expect([...f].sort((a, b) => a - b)).toEqual(f);
    expect(stepInfo('verify').label).toContain('chữ ký');
  });
  it('token đọc đúng ra số; bóng parse từ token', () => {
    expect(tapMin).toBe(48);
    expect(fontSize.base).toBe(17);
    expect(space.md).toBe(16);
    expect(parseShadow('0 2px 8px rgba(17,19,24,.08)')).toEqual({ offsetY: 2, blur: 8, alpha: 0.08 });
    expect(shadow.shadowOpacity).toBe(0.08);
  });
});
