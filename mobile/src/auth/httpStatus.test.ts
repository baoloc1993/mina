import { catalogStatusError, UnauthorizedError } from './httpStatus';
import { PackageError } from '../packages/types';

describe('catalogStatusError', () => {
  it('2xx → không lỗi', () => {
    expect(catalogStatusError(200)).toBeNull();
    expect(catalogStatusError(204)).toBeNull();
  });
  it('401 → UnauthorizedError (đẩy về đăng nhập)', () => {
    expect(catalogStatusError(401)).toBeInstanceOf(UnauthorizedError);
  });
  it('429 RATE_LIMITED → OFFLINE (lỗi tạm: giữ cache, runtime không hiện lỗi)', () => {
    const e = catalogStatusError(429) as PackageError;
    expect(e).toBeInstanceOf(PackageError);
    expect(e.code).toBe('OFFLINE');
  });
  it('lỗi máy chủ khác giữ mã INTERNAL kèm status', () => {
    const e = catalogStatusError(500) as PackageError;
    expect(e.code).toBe('INTERNAL');
    expect(e.message).toContain('500');
    expect((catalogStatusError(403) as PackageError).code).toBe('INTERNAL');
  });
});
