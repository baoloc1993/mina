import { chunk, UPLOAD_BATCH } from './chunk';

test('AC-10: lô upload chia ≤ 100 thay đổi, giữ thứ tự', () => {
  const xs = Array.from({ length: 250 }, (_, i) => i);
  const parts = chunk(xs, UPLOAD_BATCH);
  expect(parts.map((p) => p.length)).toEqual([100, 100, 50]);
  expect(parts.flat()).toEqual(xs);
  expect(chunk([], 100)).toEqual([]);
});
