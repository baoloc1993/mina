import { MAX_BACKOFF_MS, MIN_BACKOFF_MS, rateLimitDelayMs } from './retryAfter';

describe('rateLimitDelayMs', () => {
  it('không có thông tin → tối thiểu 5 s', () => {
    expect(rateLimitDelayMs(null)).toBe(MIN_BACKOFF_MS);
    expect(rateLimitDelayMs('abc', undefined)).toBe(MIN_BACKOFF_MS);
  });
  it('dùng Retry-After (giây) trong khoảng cho phép', () => {
    expect(rateLimitDelayMs('17')).toBe(17_000);
    expect(rateLimitDelayMs(null, 33)).toBe(33_000);
  });
  it('header thắng body; kẹp 5..60 s', () => {
    expect(rateLimitDelayMs('20', 40)).toBe(20_000);
    expect(rateLimitDelayMs('1')).toBe(MIN_BACKOFF_MS);
    expect(rateLimitDelayMs('3600')).toBe(MAX_BACKOFF_MS);
    expect(rateLimitDelayMs('-5', -1)).toBe(MIN_BACKOFF_MS);
  });
});
