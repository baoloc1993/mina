import { validateCode, validateEmail, viAuthError } from './messages';

describe('thông báo đăng nhập tiếng Việt', () => {
  test('email trống và sai định dạng được chặn ở client', () => {
    expect(validateEmail('')).toMatch(/Nhập email/);
    expect(validateEmail('   ')).toMatch(/Nhập email/);
    expect(validateEmail('abc')).toMatch(/định dạng/);
    expect(validateEmail('a@test.local')).toBeNull();
  });
  test('mã phải đúng 6 chữ số', () => {
    expect(validateCode('12345')).not.toBeNull();
    expect(validateCode('12a456')).not.toBeNull();
    expect(validateCode('123456')).toBeNull();
  });
  test('lỗi mạng không lộ địa chỉ nội bộ', () => {
    const out = viAuthError(new Error('fetch failed: java.net.ConnectException: Failed to connect to /10.0.2.2:54321'), 'send');
    expect(out).toMatch(/kết nối mạng/);
    expect(out).not.toMatch(/10\.0\.2\.2|java|ConnectException/);
  });
  test('mã sai / hết hạn báo tiếng Việt thuần', () => {
    const out = viAuthError(new Error('Token has expired or is invalid'), 'verify');
    expect(out).toMatch(/Mã sai hoặc đã hết hạn/);
    expect(out).not.toMatch(/Token|expired|invalid/);
  });
  test('rate limit báo thao tác quá nhanh', () => {
    expect(viAuthError(new Error('email rate limit exceeded'), 'send')).toMatch(/quá nhanh/);
  });
});
