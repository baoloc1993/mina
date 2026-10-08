import { pickEvictions } from './evict';

const r = (id: string, status: 'local' | 'uploading' | 'uploaded' | 'cached', size: number, t: number) => ({ id, status, size, last_used_at: t });

test('AC-11: dọn cũ nhất trước, KHÔNG BAO GIỜ dọn file chưa upload', () => {
  const rows = [r('a', 'local', 500, 1), r('b', 'uploading', 500, 2), r('c', 'cached', 400, 3), r('d', 'uploaded', 400, 4)];
  expect(pickEvictions(rows, 1000)).toEqual(['c', 'd']);
  expect(pickEvictions(rows, 0)).toEqual(['c', 'd']); // dù ngưỡng 0, local/uploading vẫn giữ
});
test('dưới ngưỡng thì không dọn gì; dừng ngay khi đủ', () => {
  const rows = [r('c', 'cached', 400, 3), r('d', 'uploaded', 400, 4), r('e', 'cached', 400, 5)];
  expect(pickEvictions(rows, 2000)).toEqual([]);
  expect(pickEvictions(rows, 900)).toEqual(['c']);
});
