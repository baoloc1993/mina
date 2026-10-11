import { pickEvictions } from './notifyEvict';

const NOW = 1_000_000_000;
const DAY = 86_400_000;
const up = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `u${i}`, at: NOW + (i + 1) * 1000 }));

test('60 hàng tương lai ⇒ giữ đúng 50 gần nhất, bỏ 10 xa nhất', () => {
  const rows = up(60).reverse(); // thứ tự đầu vào không quan trọng
  const { drop } = pickEvictions(rows, NOW);
  expect(drop.sort()).toEqual(Array.from({ length: 10 }, (_, i) => `u${50 + i}`).sort());
});
test('đúng 50 ⇒ không bỏ gì', () => {
  expect(pickEvictions(up(50), NOW).drop).toEqual([]);
});
test('hàng đã qua không chiếm chỗ trong 50', () => {
  const past = Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, at: NOW - 1000 - i }));
  expect(pickEvictions([...past, ...up(50)], NOW).drop).toEqual([]);
});
test('hàng đã qua > 1 ngày bị dọn, ≤ 1 ngày thì giữ', () => {
  const rows = [{ id: 'old', at: NOW - DAY - 1 }, { id: 'recent', at: NOW - DAY + 1 }, ...up(1)];
  expect(pickEvictions(rows, NOW).drop).toEqual(['old']);
});
test('cái vừa đặt xa nhất ⇒ chính nó bị bỏ', () => {
  const rows = [...up(50), { id: 'new', at: NOW + 999_999 }];
  expect(pickEvictions(rows, NOW).drop).toEqual(['new']);
});
