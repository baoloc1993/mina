import { parseProviders } from './providers';

describe('parseProviders', () => {
  it('mặc định / rỗng → không nhà nào (bản release chỉ có OTP)', () => {
    expect(parseProviders(undefined)).toEqual([]);
    expect(parseProviders('')).toEqual([]);
  });
  it('nhận google, apple, bỏ tên lạ, khoảng trắng, hoa thường, trùng', () => {
    expect(parseProviders('Google, apple ,facebook,google')).toEqual(['google', 'apple']);
    expect(parseProviders('apple')).toEqual(['apple']);
  });
});
