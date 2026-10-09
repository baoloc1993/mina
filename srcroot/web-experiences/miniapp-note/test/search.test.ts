// AC-5: chuẩn hoá tìm không dấu, mẫu LIKE, trích đoạn giữ dấu, tô đậm.
import { describe, expect, test } from 'vitest';
import { excerptAround, highlightParts, likePattern, makeSnippet, normalize, searchTerms } from '../src/search/normalize';

describe('normalize', () => {
  test.each([
    ['Ghi chú', 'ghi chu'],
    ['Đăng ký', 'dang ky'],
    ['ĐƯỜNG Hồ Chí Minh', 'duong ho chi minh'],
    ['  nhiều   khoảng\ttrắng \n', 'nhieu khoang trang'],
    ['Nguyễn Thị Ánh Tuyết', 'nguyen thi anh tuyet'],
    ['ơ ư ă â ê ô', 'o u a a e o'],
  ])('%s → %s', (a, b) => {
    expect(normalize(a)).toBe(b);
  });

  test('chuỗi dựng sẵn (NFC) và tổ hợp (NFD) cho cùng kết quả', () => {
    const nfc = 'Việt Nam đẹp'.normalize('NFC');
    const nfd = 'Việt Nam đẹp'.normalize('NFD');
    expect(normalize(nfc)).toBe('viet nam dep');
    expect(normalize(nfd)).toBe('viet nam dep');
  });

  test('từ khoá cùng hàm chuẩn hoá nên "GHI CHU" và "ghi chú" khớp như nhau', () => {
    expect(searchTerms('GHI chú')).toEqual(['ghi', 'chu']);
    expect(searchTerms('  đăng   ký ')).toEqual(['dang', 'ky']);
    expect(searchTerms('')).toEqual([]);
    expect(searchTerms('a a a')).toEqual(['a']);
  });
});

describe('likePattern', () => {
  test('escape \\ % _ để từ khoá không thành ký tự đại diện', () => {
    expect(likePattern('50%')).toBe('%50\\%%');
    expect(likePattern('a_b')).toBe('%a\\_b%');
    expect(likePattern('c:\\x')).toBe('%c:\\\\x%');
  });
});

describe('trích đoạn', () => {
  const text = 'Hôm nay họp tuần rất dài. Cần đăng ký phòng họp cho thứ Ba và gửi tài liệu trước 17:00 cho cả nhóm.';

  test('snippet cắt ở độ dài và thêm …', () => {
    expect(makeSnippet('a'.repeat(200), 50)).toHaveLength(50);
    expect(makeSnippet('a'.repeat(200), 50).endsWith('…')).toBe(true);
    expect(makeSnippet('  ngắn  ')).toBe('ngắn');
  });

  test('excerptAround giữ dấu gốc quanh chỗ khớp dù từ khoá không dấu', () => {
    const e = excerptAround(text, ['dang', 'ky'], 20);
    expect(e).toContain('đăng ký');
    expect(e.startsWith('…')).toBe(true);
  });

  test('không khớp → đầu văn bản', () => {
    expect(excerptAround(text, ['zzz'], 20).startsWith('Hôm nay')).toBe(true);
  });

  test('highlightParts đánh dấu đúng đoạn có dấu', () => {
    const parts = highlightParts('Đăng ký lịch họp', ['dang', 'ky']);
    expect(parts.filter((p) => p.hit).map((p) => p.text)).toEqual(['Đăng', 'ký']);
    expect(parts.map((p) => p.text).join('')).toBe('Đăng ký lịch họp');
    expect(highlightParts('abc', [])).toEqual([{ text: 'abc', hit: false }]);
  });
});
